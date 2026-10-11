/*
 * The rating stars of the approved Rate mockup: a soft, rounded star (its stroke rounds the
 * points), Central City blue when given, a quiet grey when not. Never the ★ glyph: every font draws
 * it differently.
 */

const STAR_PATH =
  'M12 3.6l2.5 5.1 5.6.8-4.05 3.95.96 5.58L12 16.4l-5.01 2.63.96-5.58L3.9 9.5l5.6-.8z';

/** One star; `on` fills it. Colours come from wallet-screen.css (--w4-star, --w4-star-off). */
export function StarIcon({
  on,
  size = 16,
  outline = false,
}: {
  on: boolean;
  size?: number;
  /** Drawn as a line only (the Rate button's icon). */
  outline?: boolean;
}) {
  return (
    <svg
      className="w4-star"
      data-on={on || undefined}
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
    >
      <path
        d={STAR_PATH}
        fill={outline ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={outline ? 1.8 : 2.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A rating shown, not chosen: `value` of 5 stars, with its words for screen readers. */
export function Stars({ value, size = 13 }: { value: number; size?: number }) {
  return (
    <span className="w4-stars" role="img" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <StarIcon key={star} on={star <= value} size={size} />
      ))}
    </span>
  );
}
