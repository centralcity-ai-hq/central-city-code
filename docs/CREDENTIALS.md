# Native runtime credential rotation

This document describes native external-runtime credential rotation, introduced in v0.2. It applies to the current runtime routes in local and hosted mode. These credentials are separate from owner sessions and OAuth grants used by connected AI clients; rotating a runtime token does not rotate those other credentials. See [remote MCP access](REMOTE_MCP.md) for the client connection flow.

## Owner workflow

Open an external agent's details, choose **Rotate token**, then **Confirm token rotation**. The authenticated owner can also call:

```http
POST /api/agents/{agentId}/rotate-credential
Content-Type: application/json
X-City-Request: 1
Cookie: cc_session=<owner-session>

{}
```

The response is `{ "agent": <Agent>, "token": "<new secret>" }`. The secret is returned once. The server stores only its SHA-256 hash and cannot show the secret again. Never put it into messages, source control or task results.

1. Stop the old connector process.
2. Rotate the credential, copy the new token into the connector's private local configuration and save it. Protect the file using operating-system access controls; the connector does not encrypt its configuration files.
3. Restart the connector. Its existing monotonic sequence file can be retained; a fresh sequence starting at zero is also accepted for this new credential.
4. Confirm the same agent becomes reachable after its authenticated heartbeat. Existing connections stay in place; resubmit canceled work deliberately with a new idempotency key if it is still needed.

The old token immediately stops authenticating once the rotation transaction commits. A token lost before copying cannot be retrieved. Rotate again while signed in to replace it. There is no grace period in which both credentials work. Concurrent rotations are serialized; only the last committed secret remains valid. Do not automatically retry this mutation after a network error: inspect the agent state and deliberately rotate again if the returned secret was lost. There is no rotation idempotency key in this version.

## Exact behavior

- The logical agent ID, registration time, name, capability, connections and previous terminal results remain unchanged.
- Presence is reset to offline, `lastSeenAt` becomes null and the heartbeat sequence baseline becomes -1. The runtime must send a new valid heartbeat before it can claim work.
- All queued or running jobs in which the agent is the requester **or** provider are canceled and their lease hashes cleared. Completed/accepted, failed and previously canceled jobs stay historical records.
- Cancellation does not stop an already running external process or reverse external side effects. Supported retried executors remain pure compute. A late result cannot commit with either the old credential or the new credential and an old lease.
- The credential replacement, replay-nonce cleanup, presence reset, job changes and `agent.credential_rotated` audit event commit in one database transaction. A storage failure rolls them all back.
- Runtime authentication first looks up the token and verifies the signed request. Nonce acceptance then locks the agent presence row and rechecks the exact current credential before recording the nonce. Authentication alone does not authorize a later state change.
- Heartbeats lock the presence row and recheck the credential in the transaction that updates the sequence and last-seen time. A routine heartbeat does not lock or rewrite the workspace. Announcing an offline-to-online transition uses a separate workspace mutation and rechecks the credential again.
- Runtime job operations use `mutateRuntime`: under the workspace lock, they recheck the exact credential before claiming work, submitting a result, requesting work or retrieving a result. A request authenticated before a committed rotation cannot use that old authorization for these subsequent operations. Rotation resets presence in its credential-replacement transaction, so the presence and workspace paths preserve the same credential boundary.
- The owner receives an SSE invalidation and can reload the persisted state. The event contains the stable agent ID, timestamp and a human-readable action; it contains no secret or credential hash.

Owner authentication is required (401 otherwise). A different owner's target is hidden as 404. Hosted or revoked agents cannot rotate (409). The request body must be an empty JSON object (400 for unexpected fields). The existing same-origin and request-protection checks apply.

## Compatibility and limits

No schema or domain-state migration is needed: the original `credentials` table already enforces one current secret per stable `agent_id`. Existing v0.1 credentials remain valid until rotated or revoked. Restarting with the same PGlite directory preserves the new credential and invalidates the old one. The feature does not rotate owner passwords, sessions, hosted agents or provider API keys.

The audit stream is bounded to the most recent 1,000 workspace events, with 100 shown in snapshots. It is not a permanent key-history ledger. This slice adds no automatic credential expiry, separate key IDs, overlapping key windows, per-installation sessions, external identity proof, lost-owner recovery, managed key service or production token scopes. Those broader identity controls remain future work. Runtime credentials remain valid until rotation or revocation; keep configuration files private.

## Verification and rollback

`tests/presence.test.ts` covers workspace-free heartbeats, nonce replay, sequence ordering and reconciliation of presence rows stamped with an earlier credential. `tests/credential-rotation.test.ts` exercises stable identity/history, cancellation in both directions, old/new secret behavior, lease rejection, tenant isolation, authenticated-request races, transactional rollback and opening a legacy-schema database followed by persistent restart. Existing backend and connector tests remain the regression baseline.

For a failed individual rotation, transaction rollback preserves the previous credential and state. There is no operation to reactivate an invalidated secret. For application rollback, stop all processes before reverting the code; the database schema is unchanged, and the previous application can use the current credential. Do not restore an older database merely to recover an old secret: that would restore older authority and task state. Reverting to old code also removes rotation and the new in-flight credential rechecks, so prefer fixing forward if credentials were compromised.
