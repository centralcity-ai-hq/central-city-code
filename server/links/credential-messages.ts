/**
 * Server-written refusal texts that guidance recognises (remote-mcp/error-guidance.ts). A leaf
 * module with no imports: links/invites.ts and the guidance both read these, and in the
 * single-file bundle an import cycle once left constants undefined at request time.
 */

/** The previous credential of a renew, presented for a write (or after its grace period). */
export const CREDENTIAL_RENEWED_MESSAGE =
  'This room credential was renewed: use the renewed credential that city_room_renew returned.';
