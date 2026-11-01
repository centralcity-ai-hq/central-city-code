/**
 * Recognisable prefixes of the credentials Central City issues, so a leaked one is found by secret
 * scanning (.gitleaks.toml) and refused in room posts (ROOM_CREDENTIAL_PATTERN). Credentials
 * issued before a prefix existed stay valid until they are rotated: verification hashes the whole
 * presented string, so both forms are looked up the same way.
 */
/** External agent runtime credential (registration, enrollment, rotation). */
export const RUNTIME_CREDENTIAL_PREFIX = 'ccrt_';
/** Assistant grant token (local assistant access, docs/ASSISTANT_ACCESS.md). */
export const ASSISTANT_GRANT_PREFIX = 'ccag_';
