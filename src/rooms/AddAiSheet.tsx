import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { withRoomDeadline, type JoinLink, type RoomsClient } from './api';
import { describe } from './useRoomThread';
import { useDialogFocus } from './useDialogFocus';
import { joinLinkCache } from './joinLinkCache';
import { AiGlyph } from './WhoJoins';
import { roomInviteCopyLine } from '../shell/roomInvite';
import {
  AI_APPS,
  aiAppSteps,
  connectEndpoint,
  isLocalConnect,
  joinedAi,
  nextAiApp,
  type AiAppId,
} from './aiApps';

/** Members are polled while the sheet is open (as the Invite sheet), for at most 10 minutes. */
const MEMBER_POLL_MS = 3_000;
const MEMBER_POLL_LIMIT_MS = 10 * 60_000;
const COPIED_MS = 2_000;

type Copied = 'row' | 'invite' | null;

/**
 * "Add an AI" (docs/design/ROOM_WHO_JOINS.md §3): one flow for every AI app. Pick the app, follow
 * its one action (Open or Copy), then copy the room invite into it. The steps block has a fixed
 * height, so switching apps never resizes the sheet. Closes itself when an AI joins the room.
 */
export function AddAiSheet({
  client,
  roomId,
  onClose,
  onJoined,
}: {
  client: RoomsClient;
  roomId: string;
  onClose: () => void;
  /** An AI that was not in the room when the sheet opened is in it now. */
  onJoined: () => void;
}) {
  const id = useId();
  const sheet = useRef<HTMLDivElement>(null);
  useDialogFocus(sheet, onClose);
  const [app, setApp] = useState<AiAppId>('claude');
  const [copied, setCopied] = useState<Copied>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [link, setLink] = useState<JoinLink | null>(() => joinLinkCache.get(roomId) ?? null);
  const radios = useRef(new Map<AiAppId, HTMLButtonElement>());
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const joined = useRef(onJoined);
  joined.current = onJoined;

  const local = isLocalConnect();
  const steps = aiAppSteps(app, connectEndpoint(), local);
  const current = AI_APPS.find((item) => item.id === app) ?? AI_APPS[0];

  // The room's invite link, made once per page (shared with the Invite sheet), ready for Copy.
  useEffect(() => {
    if (link) return;
    let active = true;
    withRoomDeadline(client.joinLink({ room_id: roomId }))
      .then((value) => {
        joinLinkCache.set(roomId, value);
        if (active) setLink(value);
      })
      .catch(() => {
        // Copy room invite tries again and reports the error.
      });
    return () => {
      active = false;
    };
  }, [client, roomId, link]);

  // "Waiting for your AI to join…": an AI that was not here when the sheet opened closes it.
  useEffect(() => {
    let active = true;
    let baseline: Set<string> | null = null;
    const started = Date.now();
    const tick = async () => {
      try {
        const members = await withRoomDeadline(client.members({ room_id: roomId }));
        if (!active) return;
        if (!baseline) baseline = new Set(members.map((member) => member.id));
        else if (joinedAi(baseline, members)) {
          joined.current();
          return;
        }
      } catch {
        // Best effort: the steps are what matter.
      }
      if (active && Date.now() - started < MEMBER_POLL_LIMIT_MS)
        timer = window.setTimeout(() => void tick(), MEMBER_POLL_MS);
    };
    let timer = window.setTimeout(() => void tick(), 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, roomId]);

  async function copy(value: string, which: Exclude<Copied, null>, what: string) {
    window.clearTimeout(copiedTimer.current);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setError('');
      setStatus(`${what} copied to the clipboard.`);
      copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
    } catch {
      setCopied(null);
      setStatus('');
      setError('Clipboard unavailable. Select and copy the text manually.');
    }
  }

  async function copyInvite() {
    let value = link;
    if (!value) {
      try {
        value = await withRoomDeadline(client.joinLink({ room_id: roomId }));
        joinLinkCache.set(roomId, value);
        setLink(value);
      } catch (err) {
        setStatus('');
        setError(describe(err));
        return;
      }
    }
    await copy(roomInviteCopyLine(value.url), 'invite', 'Room invite');
  }

  function pick(next: AiAppId, focus = false) {
    setApp(next);
    setCopied(null);
    setStatus('');
    setError('');
    if (focus) radios.current.get(next)?.focus();
  }

  function onAppKey(event: KeyboardEvent<HTMLButtonElement>) {
    const next = nextAiApp(app, event.key);
    if (!next) return;
    event.preventDefault();
    pick(next, true);
  }

  const row = steps.row;
  return (
    <div
      className="rm-backdrop rm-v3-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={sheet}
        className="rm-sheet rm-v3-sheet rm-add-ai"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-lede`}
      >
        <div className="rm-add-ai-head">
          <AiGlyph />
          <div className="rm-add-ai-titles">
            <h2 id={`${id}-title`}>Add an AI</h2>
            <p id={`${id}-lede`}>Pick your AI app. It joins this room only.</p>
          </div>
          <button type="button" className="rm-v3-close" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="rm-add-ai-label" id={`${id}-which`}>
          Which AI?
        </p>
        <div className="rm-add-ai-apps" role="radiogroup" aria-labelledby={`${id}-which`}>
          {AI_APPS.map((item) => (
            <button
              key={item.id}
              ref={(element) => {
                if (element) radios.current.set(item.id, element);
                else radios.current.delete(item.id);
              }}
              type="button"
              role="radio"
              aria-checked={item.id === app}
              tabIndex={item.id === app ? 0 : -1}
              autoFocus={item.id === app}
              className="rm-add-ai-app"
              onClick={() => pick(item.id)}
              onKeyDown={onAppKey}
            >
              <i style={{ background: item.color }} aria-hidden="true">
                {item.glyph}
              </i>
              {item.name}
            </button>
          ))}
        </div>
        <div className="rm-add-ai-how" data-app={app}>
          <p className="rm-add-ai-step">
            <span className="rm-add-ai-n" aria-hidden="true">
              1
            </span>
            <span>{steps.lead}</span>
          </p>
          <div className="rm-add-ai-row" data-action={row.action}>
            <span className="rm-add-ai-row-text" title={row.text}>
              {row.text}
            </span>
            {row.action === 'open' ? (
              <a
                className="rm-v3-btn rm-v3-btn-primary rm-v3-btn-sm"
                href={row.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${current.name}`}
              >
                Open
              </a>
            ) : (
              <button
                type="button"
                className="rm-v3-btn rm-v3-btn-primary rm-v3-btn-sm"
                aria-label={`Copy ${row.describedAs}`}
                onClick={() => void copy(row.value, 'row', row.describedAs)}
              >
                {copied === 'row' ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          <p className="rm-add-ai-step">
            <span className="rm-add-ai-n" aria-hidden="true">
              2
            </span>
            <span>{steps.note}</span>
          </p>
          <p className="rm-add-ai-step">
            <span className="rm-add-ai-n" aria-hidden="true">
              3
            </span>
            <span>{steps.then}</span>
          </p>
          <button
            type="button"
            className="rm-v3-btn rm-v3-btn-ghost rm-v3-btn-block rm-add-ai-invite"
            onClick={() => void copyInvite()}
          >
            {copied === 'invite' ? 'Copied' : 'Copy room invite for your AI'}
          </button>
        </div>
        {error ? (
          <p className="rm-add-ai-wait rm-add-ai-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="rm-add-ai-wait">
            <span className="rm-add-ai-pulse" aria-hidden="true" />
            Waiting for your AI to join…
          </p>
        )}
        <p className="rm-add-ai-status" role="status">
          {status}
        </p>
      </div>
    </div>
  );
}
