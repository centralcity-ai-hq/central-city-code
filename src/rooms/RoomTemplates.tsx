import { useId } from 'react';
import { Check } from 'lucide-react';
import { BLANK_ROOM_TEMPLATE_ID, ROOM_TEMPLATES } from '../../shared/room-templates';

/*
 * Room templates in the UI (shared/room-templates.ts, docs/ROOMS.md "Room templates"): the
 * "Start from" chips in New room. A template never invites anyone; who joins a new room is the
 * host's choice in "Who should join?" (src/rooms/WhoJoins.tsx).
 */

/** "a coding AI, a reviewer AI and a person": a template's suggested members as one phrase. */
function suggested(labels: string[]) {
  const lower = labels.map((label) => label.charAt(0).toLowerCase() + label.slice(1));
  return lower.length > 1 ? `${lower.slice(0, -1).join(', ')} and ${lower.at(-1)}` : lower[0];
}

/**
 * "Start from" (docs/design/NEW_ROOM.md): the templates as native radios drawn as chips (Blank
 * first, so it is the default), so arrow keys move between them and screen readers hear one
 * choice. Under them one line says what the picked template sets (its topic) and who it suggests;
 * a template never adds tasks, the name or any member.
 */
export function RoomTemplatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const ordered = [
    ...ROOM_TEMPLATES.filter((template) => template.id === BLANK_ROOM_TEMPLATE_ID),
    ...ROOM_TEMPLATES.filter((template) => template.id !== BLANK_ROOM_TEMPLATE_ID),
  ];
  const picked = ordered.find((template) => template.id === value) ?? ordered[0]!;
  const invites = picked.invites ?? [];
  return (
    <fieldset className="rm-room-templates" aria-describedby={`${id}-about`}>
      <legend>Start from</legend>
      <div className="rm-room-template-chips">
        {ordered.map((template) => (
          <label key={template.id} className="rm-room-template">
            <input
              type="radio"
              name={`${id}-room-template`}
              value={template.id}
              checked={value === template.id}
              onChange={() => onChange(template.id)}
            />
            <span className="rm-room-template-chip">
              {value === template.id ? <Check size={14} aria-hidden="true" /> : null}
              {template.name}
            </span>
          </label>
        ))}
      </div>
      <p className="rm-room-template-about" id={`${id}-about`} aria-live="polite">
        {invites.length ? (
          <span className="rm-room-template-who" aria-hidden="true">
            {invites.map((invite, index) => (
              <i key={index} data-kind={invite.kind} />
            ))}
          </span>
        ) : null}
        <span>
          {picked.id === BLANK_ROOM_TEMPLATE_ID
            ? 'An empty room. You set the topic.'
            : `${picked.topic} Suggests ${suggested(invites.map((invite) => invite.label))}.`}
        </span>
      </p>
    </fieldset>
  );
}

/** The browser key that remembers "Hide" on one room's "Who should join?" card. */
export function suggestionsHiddenKey(roomId: string) {
  return `cc_room_suggestions_hidden_${roomId}`;
}

export function readSuggestionsHidden(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeSuggestionsHidden(key: string, hidden = true) {
  try {
    if (hidden) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode or storage blocked: hidden for this page only.
  }
}
