# Connect a local assistant through MCP

Central City supplies a **local stdio MCP bridge**. A host that can launch a local MCP server process can use an owner-issued assistant grant to inspect the owner's workspace and perform the explicitly granted actions. It does not copy ChatGPT/Claude into an agent, inherit a subscription's model access, connect a cloud account automatically, or create a hosted remote connector.

## Local setup

1. Start the local Central City app and sign in as its owner. Create an assistant-access grant with a descriptive label, the minimum scopes, and a short expiry. Start with `workspace:read`.
2. Save the one-time token in a **private JSON file outside the repository**, using an absolute path. Do not paste that file or token into a chat, commit it, add it to environment/command arguments, or give it to an agent as task input.
3. Configure the MCP host to start Node directly with the local bridge and configuration path. The app and bridge run on the same computer. Revoke the grant in the owner console when access is no longer wanted.

Private file contents (replace the token locally):

```json
{
  "baseUrl": "http://127.0.0.1:4310",
  "token": "REPLACE_WITH_THE_ONE_TIME_ASSISTANT_GRANT_TOKEN"
}
```

An MCP host configuration for Windows might use the following structure; substitute actual absolute paths and the host's supported configuration location:

```json
{
  "mcpServers": {
    "central-city": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/path/to/central-city/node_modules/tsx/dist/cli.mjs",
        "C:/path/to/central-city/mcp/cli.ts",
        "--config",
        "C:/path/to/private/central-city-assistant.json"
      ]
    }
  }
}
```

Use Node >=22.18.0 and the application's installed, locked dependencies. The executable and script paths are configuration, not secrets. `pnpm assistant:mcp --config <absolute-path>` is available for manual startup; **use the direct Node command in an MCP host**, because package-manager banners can corrupt the stdio protocol channel. A started bridge waits for MCP input; silence is expected. On Unix, make the private file owner-readable only (`chmod 600`). On Windows, use an owner-private directory and its ACLs; the bridge does not claim to verify Windows ACLs.

## Tools and authority

| Tool | Scope | Behavior |
| --- | --- | --- |
| `city_workspace` | `workspace:read` | Returns owner, public agent/connection records and pause state. Optional `limit` (1-200, default 100) and `cursor`: a workspace of more than 500 agents, or a call with either, returns one page of agents, newest first, with `agents_total` and `next_cursor`. |
| `city_create_agent` | `agents:create` | Creates a record with a stable caller-supplied idempotency key. A hosted record is a deterministic demo. An external record needs owner runtime setup; no runtime secret is returned. |
| `city_create_job` | `jobs:create` | Requests a granted hosted deterministic provider using a stable idempotency key. Existing native permissions, reachability, pause and capacity checks apply. |
| `city_get_job` | `workspace:read` | Reads one job in the owner's workspace. |
| `city_cancel_job` | `jobs:cancel` | Cancels active owned work; it does not reverse effects or accept results. |
| `city_list_templates` | `workspace:read` | Lists built-in zero-cost agent and team templates. |
| `city_plan_team` | `workspace:read` | Dry-run plan of a Team or Agent manifest or template; creates nothing. |
| `city_create_agent` (manifest mode) | `agents:create` | `manifest` or `template` (+ `overrides`) with `idempotency_key`, or `dry_run`. External runtimes receive a single-use, 15-minute `enrollment_code` their runtime exchanges at `POST /api/runtime/enroll` for its credential; no owner rotation step is needed. |
| `city_apply_team` | `agents:create` + `connections:create` | Applies a zero-cost Team manifest atomically: agents, the team's directional connections and manifest revisions. Connections require `connections:create`. |
| `city_control` | `agents:control` | Pauses, resumes or revokes an agent. Revocation cascades to every agent created under it. |
| `city_send_message` | `messages:send` | Sends a message as one workspace agent to another along an existing directional connection ([MESSAGING.md](MESSAGING.md)). |
| `city_read_inbox` | `messages:read` | Reads an agent's inbox after `since` (default: after the acknowledged seq). |
| `city_ack_inbox` | `messages:read` | Acknowledges an agent's inbox up to `seq` (monotonic). |

Scopes are chosen by the owner when issuing a grant or on the OAuth consent page:

| Scope | Allows |
| --- | --- |
| `workspace:read` | Always granted: read the workspace, jobs, templates and plans. |
| `agents:create` | Create agents (legacy fields or manifests) and apply teams without connections. |
| `connections:create` | Authorize directional connections between members of teams the assistant applies. It cannot connect arbitrary existing agents. |
| `agents:control` | Pause, resume and revoke agents (revocation cascades down the lineage). |
| `jobs:create` | Request work from connected hosted demo agents. |
| `jobs:cancel` | Cancel active jobs. |
| `messages:send` | Send messages as the workspace's agents, only along connections the owner authorized. |
| `messages:read` | Read and acknowledge the workspace's agent inboxes, including message contents. |

The messaging tools are served by the backend tool endpoint (`POST /api/assistant/tools/<tool>`) and remote MCP today; registering them in the stdio bridge (`mcp/bridge.ts`) is a follow-up.

Autonomous creation is zero-cost only: manifests with a non-zero budget or a paid model provider are refused (`OWNER_APPROVAL_REQUIRED`) until an owner approval step exists. No tool can accept a result, rotate credentials, change an account or perform paid external-provider execution. The backend rechecks the current assistant grant, expiry and scopes for each call. Tools remain listed even if a read-only/revoked grant cannot execute a write; listing is not permission. MCP annotations help host presentation but do not replace server authorization. Agent names, task text and results are untrusted data; they must not override the host's instructions.

In hosted server mode, authorized `city_workspace` and `city_get_job` reads also advance
already-admitted deterministic jobs in that owner's workspace, after validating arguments
and access under the workspace lock. They cannot admit work or accept results. Pause prevents
execution; cancellation does not first advance a running job. Admission refreshes demo
presence without advancing other jobs. This removes the backend's dependency on browser
snapshot polling. The supplied stdio bridge remains loopback-only; this behavior does not
introduce remote MCP, OAuth or hosted assistant onboarding.

Workspace/job data returned by the bridge enters the connected assistant host's context. Grant access only to a host you intend to receive that data. The bridge keeps its configuration credential out of tool definitions/results and masks transport/backend error bodies. Revocation takes effect for subsequent backend checks; it cannot remove data an assistant already received.

## Transport and failure limits

- Only literal `http://127.0.0.1[:port]` or `http://[::1][:port]` origins are accepted, with an optional trailing slash. Hostnames, alternate numeric spellings, URL credentials, paths, query strings, fragments and non-loopback hosts are rejected. Tool URLs are fixed by code; no tool can supply a URL.
- Redirects are refused. Requests time out after 10 seconds; JSON responses are capped at 512 KiB; config files at 8 KiB; stdio frames at 64 KiB. Existing native input limits also apply. Config must be an absolute regular file, not a final symlink or hardlink; Unix group/other permission bits are rejected. This is not protection from another process with the same user's filesystem access.
- No automatic write retry occurs. A network failure can leave the outcome unknown after the backend committed a write. Inspect the owner console before retrying; reuse the same idempotency key and unchanged arguments when retrying agent/job creation. Changed input with the same key conflicts.
- Startup/protocol diagnostics use fixed messages on stderr; stdout is reserved for MCP. Backend HTTP error bodies and raw exceptions are never included in model-visible tool errors. Exact configured-token echoes, including JSON-escaped echoes, are refused.
- Expired/revoked grants require a new owner-issued grant and an updated private config/restarted bridge. Restored databases omit assistant authority; an old config cannot silently regain access.

## Verified compatibility and remaining cloud work

Dependencies are pinned to official `@modelcontextprotocol/server` **2.1.0** and test-only `@modelcontextprotocol/client` **2.1.0**. The v2 server's supported stdio factory API and the packages' installed declarations were inspected. On 25 September 2026 the automated client actually negotiated **2026-07-28** in modern mode and **2025-11-25** in legacy mode. Tests launch a separate bridge process, list/call tools through the official client, and use actual loopback HTTP requests to a synthetic Central City application. This is real protocol-boundary testing, not a hand-written mock handshake.

No interactive ChatGPT, Claude Desktop, Claude Code, Cursor or VS Code connection was tested in this slice. Hosts supporting local stdio can be configured using their own instructions, but their individual setup/approval behavior is not certified here. ChatGPT cloud and Claude web remote connections require a separate accessible remote-MCP/authentication design. This local bearer grant is not OAuth and this bridge exposes no remote HTTP MCP endpoint. No tunnel, cloud subscription change, account linking or paid service was created.

Primary documentation checked on 25 September 2026: [official MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/), [stdio serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html), [official client setup](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-client.html), [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth), and [Claude remote connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). These describe upstream capabilities and future requirements; they do not establish a cloud connection for Central City.

## Reproduce

Run `pnpm exec tsx --test tests/mcp-bridge.test.ts` and `pnpm typecheck`. Four bounded test groups cover config rejection, HTTP bounds/redirect/no-retry/error/credential handling, stdio startup/frame bounds and real modern/legacy SDK tool calls with idempotency, directional permission, cross-owner, read-only and revocation checks. Tests use only synthetic credentials/data and clean their temporary files/processes. Remove the bridge scripts/dependencies to disable this adapter; revoke backend grants separately, since removing a local process does not revoke a credential.
