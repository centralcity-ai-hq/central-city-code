import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import {
  CATCH_UP_BUSY_CODE,
  CATCH_UP_OFF_CODE,
  CATCH_UP_PAUSED_CODE,
  type CatchUp,
  type CatchUpRequest,
} from '../../shared/elric-catch-up';

export type { CatchUp, CatchUpBullet, CatchUpSection } from '../../shared/elric-catch-up';
export {
  CATCH_UP_NOTHING_TEXT,
  CATCH_UP_SECTION_TITLES,
  CATCH_UP_TITLE,
} from '../../shared/elric-catch-up';

/**
 * Elric's "While you were away" catch-up for the New-since divider (POST
 * /api/rooms/:room/catch-up). Private to the signed-in person: the server never posts it.
 *
 * - `off`: no catch-up here. `reason` says why in one quiet line: `room` (the host's Elric is
 *   off here) or `account` (the person is not eligible for Elric); `null` (Elric is off for
 *   everyone right now, or no such room) shows nothing at all.
 * - `limited`: too many catch-ups just now (429); `retryAfterMs` is the server's Retry-After.
 * - `ready`: `data` holds the sections; each bullet's `seqs` are the messages to link.
 *   `data.nothing_important` means show CATCH_UP_NOTHING_TEXT. `data.incomplete` with
 *   `data.notice` means only the room-data sections are there (for example a daily limit).
 * - `error`: anything else (network, server); `reload()` tries again.
 */
export type CatchUpState =
  | { status: 'idle' | 'loading'; data: null }
  | { status: 'off'; data: null; reason: CatchUpOffReason }
  | { status: 'limited'; data: null; retryAfterMs?: number }
  | { status: 'ready'; data: CatchUp }
  | { status: 'error'; data: null };

export function fetchCatchUp(
  room: string,
  range: CatchUpRequest = {},
  signal?: AbortSignal,
): Promise<CatchUp> {
  const body: CatchUpRequest = {
    ...(range.after_seq !== undefined ? { after_seq: range.after_seq } : {}),
    ...(range.to_seq !== undefined ? { to_seq: range.to_seq } : {}),
  };
  return api<CatchUp>(`/api/rooms/${encodeURIComponent(room)}/catch-up`, body, 'POST', signal);
}

export type CatchUpOffReason = 'room' | 'account' | null;

/**
 * Refusals that mean "no catch-up in this room for you" (do not retry), with the reason to show;
 * `undefined` when the error is not such a refusal.
 */
export function offReason(error: unknown): CatchUpOffReason | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 404 || error.code === CATCH_UP_PAUSED_CODE) return null;
  if (error.code === CATCH_UP_OFF_CODE) return 'room';
  if (error.status === 403 && (error.code ?? '').startsWith('elric_')) return 'account';
  return undefined;
}

const BUSY_RETRY_MS = 1_500;

/**
 * Loads the catch-up when `enabled` (the divider is open) for the range after `afterSeq` up to
 * `toSeq`. A new range loads again; the server's cache makes a repeat free.
 */
export function useCatchUp(
  room: string | null,
  options: { afterSeq?: number; toSeq?: number; enabled: boolean },
): CatchUpState & { reload: () => void } {
  const [state, setState] = useState<CatchUpState>({ status: 'idle', data: null });
  const [attempt, setAttempt] = useState(0);
  const busyRetried = useRef(false);
  const { afterSeq, toSeq, enabled } = options;

  useEffect(() => {
    if (!room || !enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: 'loading', data: null });
    fetchCatchUp(
      room,
      {
        ...(afterSeq !== undefined ? { after_seq: afterSeq } : {}),
        ...(toSeq !== undefined ? { to_seq: toSeq } : {}),
      },
      controller.signal,
    )
      .then((data) => {
        busyRetried.current = false;
        setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = offReason(error);
        if (reason !== undefined) return setState({ status: 'off', data: null, reason });
        if (error instanceof ApiError && error.status === 429)
          return setState({
            status: 'limited',
            data: null,
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          });
        // Another tab is writing the same catch-up: ask once more shortly (then it is cached).
        if (
          error instanceof ApiError &&
          error.code === CATCH_UP_BUSY_CODE &&
          !busyRetried.current
        ) {
          busyRetried.current = true;
          timer = setTimeout(() => setAttempt((n) => n + 1), BUSY_RETRY_MS);
          return;
        }
        setState({ status: 'error', data: null });
      });
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [room, afterSeq, toSeq, enabled, attempt]);

  const reload = useCallback(() => {
    busyRetried.current = false;
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, reload };
}
