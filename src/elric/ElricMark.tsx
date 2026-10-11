/**
 * Elric's avatar in Workspace v3: the Central City mark in white on the accent (a rounded square,
 * as every AI avatar). Decorative: Elric's name is always next to it. Sizes follow the rooms'
 * avatars (xs 24, sm 28, md 40) plus the Home orb (52, with its slow halo; elric-v3.css).
 */
export function ElricMark({
  size = 'md',
  className = '',
}: {
  size?: 'xs' | 'sm' | 'md' | 'orb';
  className?: string;
}) {
  return (
    <span
      className={`elx3-mark elx3-mark-${size}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      <span className="elx3-mark-glyph" />
    </span>
  );
}
