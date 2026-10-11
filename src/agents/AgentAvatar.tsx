import { useAvatarStyle } from '../shell/avatarColor';

/** First letters of up to two words ("Research scout" → "RS"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

/**
 * An agent's avatar: the colour for its agent id (avatarColor.ts; within My agents every agent
 * gets a different one) and white initials.
 */
export function AgentAvatar({
  id,
  name,
  size = 'md',
}: {
  id: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span className="ma3-avatar" data-size={size} style={useAvatarStyle(id)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
