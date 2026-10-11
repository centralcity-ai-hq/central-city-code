import { useId } from 'react';
import { X } from 'lucide-react';

/*
 * "Who should join?" (docs/design/ROOM_WHO_JOINS.md §2): the host's card in a room nobody else
 * has joined yet. Two tiles, each one button: An AI opens the Add an AI sheet, A person opens the
 * Invite sheet. Nobody is invited by the card itself.
 */

/** The dashed robot glyph (An AI). */
export function AiGlyph() {
  return (
    <span className="rm-who-glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <rect x="5" y="8" width="14" height="11" rx="3" />
        <path d="M12 4v4M9 13h.01M15 13h.01" />
      </svg>
    </span>
  );
}

/** The dashed, round person glyph (A person). */
export function PersonGlyph() {
  return (
    <span className="rm-who-glyph rm-who-glyph-round" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
      </svg>
    </span>
  );
}

export function WhoJoinsCard({
  onAi,
  onPerson,
  onHide,
}: {
  onAi: () => void;
  onPerson: () => void;
  onHide: () => void;
}) {
  const id = useId();
  return (
    <section className="rm-who" aria-labelledby={`${id}-title`} aria-describedby={`${id}-sub`}>
      <div className="rm-who-head">
        <div>
          <h2 id={`${id}-title`}>Who should join?</h2>
          <p id={`${id}-sub`}>Nobody joins until you invite them.</p>
        </div>
        <button
          type="button"
          className="rm-who-hide"
          aria-label="Hide Who should join?"
          title="Show it again from More room actions"
          onClick={onHide}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="rm-who-tiles">
        <button type="button" className="rm-who-tile" onClick={onAi}>
          <AiGlyph />
          <span className="rm-who-tile-text">
            <strong>An AI</strong>
            <span>Builds, reviews or helps</span>
          </span>
          <span className="rm-who-plus" aria-hidden="true">
            +
          </span>
        </button>
        <button type="button" className="rm-who-tile" onClick={onPerson}>
          <PersonGlyph />
          <span className="rm-who-tile-text">
            <strong>A person</strong>
            <span>Decides and approves</span>
          </span>
          <span className="rm-who-plus" aria-hidden="true">
            +
          </span>
        </button>
      </div>
    </section>
  );
}
