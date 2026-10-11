import { useCallback, useEffect, useState } from 'react';
import { Pin, X } from 'lucide-react';
import { listPins, pinLabel, type RoomPin } from './pins';

/*
 * Smart Rooms v2 (preview): the thin "Context" row under the room header (SPEC: Context Pins
 * bar). It is its own component, placed right below the header, so header rewrites do not touch
 * it. Only rendered with the rooms_v2 flag on (RoomView.tsx); styles in rooms-v2-pins.css.
 * Notes, excerpts and titles are untrusted text: shown as text, never followed.
 */

/** Chips shown before "+N". */
export const VISIBLE_PINS = 3;
const REFRESH_MS = 30_000;

/**
 * The room's pins, refreshed while the room is open; null until the first load (or on 404).
 * `enabled` false (the rooms_v2 flag off) makes no request at all.
 */
export function useRoomPins(roomId: string, enabled: boolean) {
  const [pins, setPins] = useState<RoomPin[] | null>(null);
  const refresh = useCallback(async () => {
    try {
      setPins(await listPins(roomId));
    } catch {
      // A server without pins (404) or a failed read: the row simply stays hidden.
    }
  }, [roomId]);
  useEffect(() => {
    setPins(null);
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, enabled]);
  return { pins, setPins, refresh };
}

export function ContextPins({
  pins,
  onOpen,
  onUnpin,
  canUnpin,
}: {
  pins: RoomPin[] | null;
  /** A message chip jumps to the message; a task chip opens the task. */
  onOpen: (pin: RoomPin) => void;
  onUnpin?: ((pin: RoomPin) => void) | undefined;
  /** Whether the viewer may unpin a pin (its pinner or the host, in an open room). */
  canUnpin?: ((pin: RoomPin) => boolean) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!pins?.length) return null;
  const shown = expanded ? pins : pins.slice(0, VISIBLE_PINS);
  const more = pins.length - shown.length;
  return (
    <div
      className="rm-v2-pins"
      role="region"
      aria-label="Pinned context"
      data-testid="context-pins"
    >
      <span className="rm-v2-pins-label">
        <Pin size={12} aria-hidden="true" />
        Context:
      </span>
      <ul className="rm-v2-pins-list">
        {shown.map((pin) => {
          const label = pinLabel(pin);
          const kind = pin.task
            ? `Task T${pin.task.number}`
            : `Message from ${pin.message?.sender}`;
          return (
            <li key={pin.id} className="rm-v2-pin" data-kind={pin.kind}>
              <button
                type="button"
                className="rm-v2-pin-chip"
                data-testid="context-pin"
                title={`${kind}${pin.note ? `: ${pinLabel({ ...pin, note: '' })}` : ''}`}
                onClick={() => onOpen(pin)}
              >
                {pin.task ? <span className="rm-v2-pin-kind">T{pin.task.number}</span> : null}
                <span className="rm-v2-pin-text">
                  {pin.task && !pin.note ? pin.task.title : label}
                </span>
              </button>
              {onUnpin && canUnpin?.(pin) ? (
                <button
                  type="button"
                  className="rm-v2-pin-remove"
                  aria-label={`Unpin ${label}`}
                  onClick={() => onUnpin(pin)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          className="rm-v2-pins-more"
          aria-expanded={false}
          aria-label={`Show ${more} more pinned`}
          onClick={() => setExpanded(true)}
        >
          +{more}
        </button>
      ) : expanded && pins.length > VISIBLE_PINS ? (
        <button
          type="button"
          className="rm-v2-pins-more"
          aria-expanded={true}
          onClick={() => setExpanded(false)}
        >
          Less
        </button>
      ) : null}
    </div>
  );
}
