import type { JoinLink } from './api';

/**
 * One join link per room for this page's lifetime, shared by the Invite sheet and the Add an AI
 * sheet so opening both never makes a second link. The code is never written to storage.
 */
export const joinLinkCache = new Map<string, JoinLink>();

/** A link this close to its end counts as expired, so a copied link still works when pasted. */
export const JOIN_LINK_MARGIN_MS = 60_000;

/** Whether the link is still valid for at least a minute (an unreadable date counts as dead). */
export function joinLinkFresh(link: JoinLink | null | undefined, now = Date.now()): boolean {
  return !!link && Date.parse(link.expires_at) > now + JOIN_LINK_MARGIN_MS;
}

/**
 * The cached link for the room, or null when there is none or it has expired (a tab left open
 * past the server's 24 h cap). An expired entry is dropped so the sheets mint a new one.
 */
export function cachedJoinLink(roomId: string, now = Date.now()): JoinLink | null {
  const link = joinLinkCache.get(roomId);
  if (joinLinkFresh(link, now)) return link!;
  joinLinkCache.delete(roomId);
  return null;
}
