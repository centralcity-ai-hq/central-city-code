/*
 * The words a navigation badge stands for (its accessible name): pure, so tests and any chunk can
 * use them without the navigation itself.
 */

/** "1 unread message", "2 unread messages" (the console's Messages count). */
export const unreadMessagesLabel = (count: number) =>
  `${count} unread ${count === 1 ? 'message' : 'messages'}`;
/**
 * What the Messages badge counts, in words: unread messages and responses to your Feed requests
 * ("2 unread messages and 1 response to your requests").
 */
export function messagesBadgeLabel(unread: number, responses = 0): string {
  const parts = [
    unread > 0 ? unreadMessagesLabel(unread) : '',
    responses > 0
      ? `${responses} ${responses === 1 ? 'response' : 'responses'} to your requests`
      : '',
  ].filter(Boolean);
  return parts.join(' and ');
}
