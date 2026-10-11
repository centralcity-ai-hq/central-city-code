# Portable workspace records

Open **Account → Settings → Data & export** in the signed-in workspace, then choose **Download workspace**. The owner-only `GET /api/workspace/export` endpoint returns the same versioned document. It uses the current session and cannot select another account by query parameter.

The document contains the operator's display identity, pause state, agents, directional connections, all retained jobs and outputs, source-brief workflows and all retained activity. This includes up to 1,000 jobs, 200 workflows and 1,000 events, rather than only the console snapshot's recent 50 jobs and 100 events. Expired history is not reconstructed. Authentication and internal authority fields are excluded through explicit projection: no password hashes, session tokens, runtime credentials, lease hashes, private idempotency keys or worker internals.

Task inputs, outputs and event text remain intact and can contain private information supplied by an operator or agent. Keep the downloaded file private. The exporter does not attempt to identify or redact arbitrary secrets inside task content.

The `central-city-workspace` version 1 format is for inspection and portability. It cannot restore application accounts, does not reset history limits, and does not delete any data. Use the separate offline [recovery tools](RECOVERY.md) for a restorable database snapshot. No import endpoint exists in this release.
