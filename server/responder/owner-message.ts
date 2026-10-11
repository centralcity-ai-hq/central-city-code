/** Only authenticated person posts by the responder's owner can carry owner instructions. */
export function isOwnerMessage(
  message: { sender_kind: string; sender_owner_id: string; auto_reply: unknown },
  ownerId: string,
): boolean {
  return (
    message.sender_kind === 'person' &&
    message.sender_owner_id === ownerId &&
    message.auto_reply == null
  );
}
