import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { openAgentPrivateRoom, PrivateRoomError } from '../../rooms/api';
import { describe } from '../../rooms/useRoomThread';

export type PrivateRoomState =
  { state: 'idle' } | { state: 'opening' } | { state: 'error'; message: string };

const FAILED = "Couldn't open the chat. Try again.";

/** The wait a 429 asked for, rounded up to seconds or minutes. */
function waitText(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return 'in a moment';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `in ${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** What the person reads when the chat didn't open (one plain sentence or two). */
export function privateRoomFailure(err: unknown, agentName: string): string {
  if (err instanceof PrivateRoomError) {
    if (err.code === 'agent_gone') return "This agent isn't yours, or it was removed.";
    if (err.code === 'agent_paused') return `${agentName} is paused. Resume it to start a chat.`;
    if (err.code === 'workspace_paused') return 'This workspace is paused.';
    if (err.code === 'person_required') return 'Switch to your own workspace to chat privately.';
    if (err.code === 'rate_limited')
      return `Too many tries just now. Try again ${waitText(err.retryAfterMs)}.`;
  }
  // A session that ended: the rooms' shared copy says to sign in again.
  if (err instanceof ApiError && err.status === 401) return describe(err);
  // A 400, a timeout, a 5xx, no network: a retry is safe (one room per agent).
  return FAILED;
}

/**
 * "Message <agent>" (POST /api/rooms/private-agent): opens the person's private chat with one of
 * their agents, created on the first open, and hands its room id on. One open at a time: a click
 * while one is on its way does nothing. The server keeps one room per agent, so a retry after a
 * failure never makes a second room. Elric's chat is /elric: a refusal for an Elric goes there.
 */
export function usePrivateRoom(
  agent: { id: string; name: string },
  onRoom: (roomId: string) => void,
  onElric: () => void,
) {
  const [status, setStatus] = useState<PrivateRoomState>({ state: 'idle' });
  const running = useRef(false);
  const { id, name } = agent;
  const open = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setStatus({ state: 'opening' });
    try {
      const room = await openAgentPrivateRoom(id);
      setStatus({ state: 'idle' });
      onRoom(room.roomId);
    } catch (err) {
      if (err instanceof PrivateRoomError && err.code === 'elric') {
        setStatus({ state: 'idle' });
        onElric();
      } else setStatus({ state: 'error', message: privateRoomFailure(err, name) });
    } finally {
      running.current = false;
    }
  }, [id, name, onRoom, onElric]);
  return { ...status, open };
}
