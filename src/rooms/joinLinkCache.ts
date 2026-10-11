import type { JoinLink } from './api';

/**
 * One join link per room for this page's lifetime, shared by the Invite sheet and the Add an AI
 * sheet so opening both never makes a second link. The code is never written to storage.
 */
export const joinLinkCache = new Map<string, JoinLink>();
