/**
 * What the host's mute leaves the viewer in an open room (migrations 35 and 65). A mute of one
 * member silences the whole owner: no composer. A bulk "Mute all AIs" (scope 'ai') still lets the
 * owner post as a person, so the composer offers only its person member. Same rule as the
 * server's refuseIfMuted; an older server without a scope counts as a full mute.
 */
export function mutePosting<M extends { kind?: 'agent' | 'person' }>(
  room: { muted?: boolean; muteScope?: 'all' | 'ai' },
  own: readonly M[],
): { blocked: boolean; posters: M[] } {
  // Not muted, but a "Mute all AIs" applies (the owner's person member is spared): its AIs may
  // not post, so the composer offers only the person.
  if (!room.muted && room.muteScope === 'ai') {
    const people = own.filter((member) => member.kind === 'person');
    if (people.length) return { blocked: false, posters: people };
  }
  if (!room.muted) return { blocked: false, posters: [...own] };
  if (room.muteScope !== 'ai') return { blocked: true, posters: [] };
  const people = own.filter((member) => member.kind === 'person');
  return { blocked: people.length === 0, posters: people };
}

/** The line shown instead of the composer. The reason is the host's words: plain text only. */
export function mutedNotice(reason: string | null | undefined): string {
  const said = reason ? ` Their reason: “${reason}”` : '';
  return `The host muted you in this room. You can still read, but not post.${said}`;
}
