import { useEffect, useRef, useState } from 'react';
import { muteAllAis, withRoomDeadline, type Member, type Room, type RoomsClient } from './api';
import { describe } from './useRoomThread';
import { serverHasSays } from './headerCountsV2';

/*
 * The host's bulk mute ("Mute all AIs" / "Unmute all"), shown in Room settings under More
 * settings (Workspace v3: the Members panel is a clean roster, so the controls live here).
 * Only when the server has the bulk route (it sends `says` on members); a 404 hides it again.
 */

export function BulkMuteControls({
  client,
  room,
  members,
  onChanged,
}: {
  client: RoomsClient;
  room: Room;
  /** The room view's member list: its `says` fields tell whether the server has the route. */
  members: Member[];
  /** After a mute change: reload members and counts. */
  onChanged: () => void;
}) {
  const [bulkGone, setBulkGone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const muteAllButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  async function setAll(mute: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await withRoomDeadline(muteAllAis(room.id, { muted: mute }));
      if (result === 'unavailable') {
        setBulkGone(true);
        setError('This server cannot mute all AIs at once yet. Mute them one by one.');
        return;
      }
      const count = `${result.changed} ${result.changed === 1 ? 'AI' : 'AIs'}`;
      setNotice(mute ? `Muted ${count}.` : `Unmuted ${count}.`);
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(`Couldn't ${mute ? 'mute' : 'unmute'} all AIs. ${describe(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (bulkGone || !serverHasSays(members)) return null;
  return (
    <div className="rm-settings-bulk">
      {error ? (
        <p className="rm-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rm-meta" role="status">
          {notice}
        </p>
      ) : null}
      {confirming ? (
        <div className="rm-confirm" role="group" aria-label="Mute all AIs?">
          <span className="rm-confirm-text">
            Mute every AI in this room? They can still read but can't post. People, your own AIs and
            Elric are not muted. You can undo this with Unmute all.
          </span>
          <span className="rm-confirm-actions">
            <button
              type="button"
              className="rm-primary"
              disabled={busy}
              onClick={() => void setAll(true)}
            >
              Mute all AIs
            </button>
            <button
              ref={cancelButton}
              type="button"
              className="rm-quiet"
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => muteAllButton.current?.focus());
              }}
            >
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <div className="rm-settings-row">
          <span className="rm-meta">Mute every AI in this room. They can still read.</span>
          <span className="rm-settings-row-actions">
            <button
              ref={muteAllButton}
              type="button"
              className="rm-quiet"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Mute all AIs
            </button>
            <button
              type="button"
              className="rm-quiet"
              disabled={busy}
              onClick={() => void setAll(false)}
            >
              Unmute all
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
