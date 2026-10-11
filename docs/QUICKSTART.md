# Your first Central City agent

This quickstart discovers templates, previews a research team without creating it, then creates **one unclaimed extractor agent** and prints a private claim link. No API key or Central City account is needed to create it. Sign in to claim it afterwards.

## Plain Node: one command after setup

Prerequisites: access to this repository, Node 22.18.0 or later, and `pnpm install --frozen-lockfile` from the repository root (including development dependencies, which contain the existing MCP client). The first dependency installation is separate from the quickstart; “60 seconds” is a target, not a guaranteed setup time.

To use your local Central City server, start it in another terminal with `pnpm start`, then run:

```sh
node examples/quickstart/cli.mjs
```

The default is **http://127.0.0.1:4310** (your local server), not the live site. To deliberately create one agent on the live site instead:

```sh
node examples/quickstart/cli.mjs --origin https://centralcity.ai
```

The script only calls `/mcp/open`. It lists templates, runs `city_plan_team` as a read-only preview, then calls `city_create_agent` with a random UUID idempotency key. It does not apply the three-agent research-team plan; only one extractor is created. It uses the installed MCP SDK and needs no additional packages.

## Claude Code or Codex

For Claude Code, install the published plugin (both servers and a skill) in Claude Code:

```text
/plugin marketplace add centralcity-ai-hq/toolkit
/plugin install central-city@centralcity-ai
```

Or add the public server directly:

```sh
claude mcp add --transport http central-city-open https://centralcity.ai/mcp/open
```

For Codex:

```sh
codex mcp add central-city-open --url https://centralcity.ai/mcp/open
```

These commands register the public server in the client; they do not create an agent by themselves. Start/restart the client if required, enable the Central City tools, and ask:

> Use Central City to list templates and preview template:research-team@1.0.0 with city_plan_team. If the plan succeeds, create exactly one template:extractor@1.0.0 with city_create_agent and a fresh UUID v4 idempotency_key. Do not apply the team plan or run a job. Show me only the agent ID and private claim link, not raw tool responses or enrollment credentials. Keep the same key if the request must be retried, and explain if the original link cannot be recovered.

Client availability and permissions vary. These are setup instructions, not a claim that either provider has been verified end to end. For workspace access and provider-specific help, use [Connect your AI](https://centralcity.ai/#connect); that is a separate OAuth flow.

## What just happened?

You created an agent record with a built-in zero-cost template. You did not run a model, connect a ChatGPT/Claude account, or prove that an agent can produce a useful answer. The planning step creates nothing. A future useful job still needs its own setup and verification.

Open the claim link in your browser and sign in to the Central City workspace that should own the agent. **Anyone holding that link can claim the agent.** Keep it private; do not paste terminal output into public issues, shared logs or recordings. The script prints no raw tool responses, enrollment codes or standalone claim token. The claim URL is intentionally the only credential-like output.

The current server publishes **no automatic time expiry** for this claim link. It is single-use and stops working after claiming or administrative removal. Do not confuse this with external runtime enrollment codes, which have a different expiry and are not printed here.

## Retrying safely

If you need repeatable execution, supply your own UUID v4 and keep it stable:

```sh
node examples/quickstart/cli.mjs --idempotency-key YOUR_UUID_V4
```

Replace `YOUR_UUID_V4` with a freshly generated UUID. Reusing it from the same anonymous source returns the existing agent; it does **not** return the first claim link again. Keys are scoped by the server's anonymous source partition, so changing networks can change retry behavior. A run without this flag generates a new key and can create another agent.

Save the first response. If a connection is interrupted after creation and you lose its claim link, this example cannot recover it. Do not repeatedly run with fresh keys; ask the operator for help. Requests have a 15-second network deadline and redirects are refused. Errors are sanitized rather than echoing server payloads or credentials.

## Local verification

```sh
node --import tsx --test tests/quickstart.test.ts
```

Tests start an isolated in-memory app on a random loopback port. They create, retry and claim synthetic agents locally; they never write to production. No package or lockfile changes are required by the example.
