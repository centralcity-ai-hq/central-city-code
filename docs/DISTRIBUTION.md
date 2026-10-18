# Distribution and discovery

How AI clients, registries and directories find and install Central City. Everything in this
branch is **prepared, not published**: registry publishing, directory submissions and new public
listings are outward-facing and need owner confirmation. Formats were checked against the
current upstream documents on 2026-09-26 (see [Sources](#sources)).

Central City has two MCP endpoints, named the same way in every configuration:

| Name | URL | Auth | Tools |
| --- | --- | --- | --- |
| `central-city-open` | `https://centralcity.ai/mcp/open` | none | `city_list_templates`, `city_plan_team`, `city_create_agent`, `city_apply_team`, `city_create_workspace`; with a room invite also `city_join_invite`, `city_room_read`, `city_room_post`, `city_room_members`, `city_room_renew` (the room credential as an argument or a Bearer header) |
| `central-city` | `https://centralcity.ai/mcp` | OAuth 2.1 or an AI workspace key (`Bearer ccw_…`) | every tool: workspace and keys, agents and jobs, messaging, rooms, wake-ups and answers (the full list is in `public/llms.txt` and the server card) |

Messaging (`city_send_message`, `city_read_inbox`, `city_ack_inbox`) is live on `/mcp` (OAuth
or workspace key, never on `/mcp/open`). `tests/distribution.test.ts` keeps an `UPCOMING_TOOLS`
list for tools that are announced but not deployed; it is empty today, and a tool listed there
must be marked "upcoming" wherever it appears.

## Channel status

| Channel | Artifact | Status | Next step (owner) |
| --- | --- | --- | --- |
| Discovery files on centralcity.ai | `public/llms.txt`, `public/llms-full.txt`, `public/.well-known/mcp/server-card.json`, `public/.well-known/ai-catalog.json`, `vercel.json` | Prepared; served after merge to `main` | Review and merge (lead) |
| Official MCP Registry | `server.json`, [integrations/mcp-registry](../integrations/mcp-registry/README.md), `public/.well-known/mcp-registry-auth` | **Published** 2026-10-05: `ai.centralcity/central-city` 0.8.0 | Each `server.json` change: bump `version`, then `mcp-publisher publish` (owner key) |
| Claude Code (CLI) | commands in [integrations/claude-code](../integrations/claude-code/README.md) | Works today | — |
| Claude Code plugin + skill | `integrations/claude-code/central-city`, marketplace `centralcity-ai` | **Published** in https://github.com/centralcity-ai-hq/toolkit (`.claude-plugin/marketplace.json` at the root): `/plugin marketplace add centralcity-ai-hq/toolkit`, then `/plugin install central-city@centralcity-ai` | Keep the toolkit copy in sync with this folder (lead), see below |
| Claude.ai / Desktop / mobile custom connector | prefilled install links | Works today for `/mcp/open`; `/mcp` too | — |
| Claude Connectors Directory | [integrations/directories/claude-connector.md](../integrations/directories/claude-connector.md) | Kit prepared, **not submitted** | Clear blockers, submit (owner) |
| ChatGPT Plugin Directory (formerly apps) | [integrations/directories/chatgpt-app.md](../integrations/directories/chatgpt-app.md) | Kit prepared, **not submitted**; the server accepts ChatGPT's OAuth client document (blocker 1, fixed) | A recorded end-to-end ChatGPT sign-in (lead), then submit (owner) |
| ChatGPT developer mode | kit, "Available today" section | Works today for `/mcp/open`; `/mcp` supported by the server, **not yet verified end to end** with ChatGPT | Record a live ChatGPT OAuth round trip (lead) |
| Cursor | [integrations/cursor](../integrations/cursor/README.md) (`mcp.json`, one-click links, generator) | Works today | Optionally add the badge to the README (lead) |
| OpenAI Codex | [integrations/codex](../integrations/codex/README.md) (`config.toml`) | Works today | — |
| Gemini CLI | [integrations/gemini-cli](../integrations/gemini-cli/README.md) (extension + `GEMINI.md`) | Works today; published at https://github.com/centralcity-ai-hq/gemini-cli-extension (topic `gemini-cli-extension`); gallery indexing pending | Keep the repository in sync with this folder (lead) |
| VS Code / Copilot | [integrations/vscode](../integrations/vscode/README.md) (`mcp.json`, install links) | Works today | — |
| Other MCP clients | [integrations/generic](../integrations/generic/README.md) | Works today | — |
| Repositories that build agents | [integrations/agents-md](../integrations/agents-md/AGENTS.template.md) | Template ready | Link from docs (lead) |
| A2A platform-level card | — | **Skipped**: no ratified standard (see below) | Revisit when AI Catalog or A2A catalog is ratified |

"Works today" means the endpoint and the client format are live; nothing new is published by
these files except the discovery documents once merged.

## Discovery files and routing

| URL | File | Content-Type | Notes |
| --- | --- | --- | --- |
| `/llms.txt` | `public/llms.txt` | `text/plain; charset=utf-8` | llmstxt.org format: H1, summary, details, H2 link lists, `Optional` last. Also advertised by a `Link: </llms.txt>; rel="describedby"` header on `/` (llms.txt v2). |
| `/llms-full.txt` | `public/llms-full.txt` | `text/plain; charset=utf-8` | Self-contained guide (Mintlify convention); readable while the repository is private. |
| `/mcp/server-card`, `/mcp/open/server-card` | rewrite to the card file | `application/mcp-server-card+json` | The location SEP-2127 reserves (`<streamable-http-url>/server-card`); CORS `*`, `Cache-Control: public, max-age=3600`, ETag from Vercel. |
| `/.well-known/mcp/server-card.json` | `public/.well-known/mcp/server-card.json` | `application/json; charset=utf-8` | Path of the closed SEP-1649, kept for early crawlers. Same document. |
| `/.well-known/ai-catalog.json` | `public/.well-known/ai-catalog.json` | `application/ai-catalog+json` | One entry, `urn:air:centralcity.ai:mcp:central-city` → `/mcp/server-card`. Also advertised with `rel="ai-catalog"` on `/`. |

The card uses the SEP-2127 v1 shape (`$schema` `https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`,
same `name`, `version`, `description`, icons and repository as `server.json`, both remotes with
`supportedProtocolVersions`). Tools and authentication are deliberately not part of that schema,
so the card carries them under `_meta["ai.centralcity/discovery"]`: per-endpoint auth (none /
OAuth metadata URL, PKCE, CIMD and DCR, scopes), tool names, titles, annotations and scopes,
upcoming tools, REST endpoints, Agent Card URL template and documentation links.

`vercel.json` changes:

- New rewrites `/mcp/server-card` and `/mcp/open/server-card` → the static card, placed before
  the app-shell fallback. `/mcp` and `/mcp/open` stay exact rewrites to the function.
- The app-shell fallback is now `/((?!api/|\.well-known/).*)`: unknown `/.well-known/…` paths
  return **404** instead of the HTML app with status 200. Before this change
  `/.well-known/agent-card.json`, `/.well-known/mcp`, `/.well-known/openid-configuration` and
  `/.well-known/mcp-registry-auth` all answered 200 `text/html`, which misleads A2A, OAuth and
  registry clients. Static files are served before rewrites on Vercel, so files added under
  `public/.well-known/` are served as they are.
- Header rules for the files above, plus `text/plain` for `/.well-known/mcp-registry-auth` and
  `/.well-known/openai-apps-challenge` (owner-provided proofs), and the `Link` header on `/`.
  The existing security headers and the OAuth rewrites are unchanged.

The local Fastify server (`server/index.ts`, used by `pnpm start` and the browser tests) serves
`dist` with `dotfiles: 'deny'`, so `/.well-known/*` static files and `/mcp/server-card` are
production (Vercel) behavior only. Local parity would need a small change there (not in this
branch's scope).

Standards status (2026-09-26):

- **MCP server discovery.** SEP-1649 (`/.well-known/mcp/server-card.json`) was closed unmerged
  on 2026-01-26 and replaced by **SEP-2127 "MCP Server Cards"** (PR #2127, label `in-review`,
  Extensions Track, spec in `modelcontextprotocol/ext-server-card`, experimental). SEP-2127 puts
  the card at `<streamable-http-url>/server-card` and uses the AI Catalog for domain-level
  discovery; it calls `/.well-known/mcp/server-card` "not recommended". SEP-1960
  (`/.well-known/mcp`) was closed as a duplicate on 2025-12-12; `/.well-known/mcp` is therefore
  not served. The 2026-07-28 specification has nothing normative about well-known discovery;
  live values come from `server/discover`.
- **AI Catalog** (`/.well-known/ai-catalog.json`, `Agent-Card/ai-catalog`): a working draft
  steered by the Linux Foundation with MCP and A2A participants, not ratified, but served by
  GitHub and Buildkite and referenced by SEP-2127. Used here only for the MCP card entry.
- **A2A platform card: skipped.** A2A 1.0.1 defines one Agent Card per domain at
  `/.well-known/agent-card.json`; its discovery guide says it "does not prescribe a standard API
  for curated registries". Central City is a platform of many agents, each with a signed card at
  `/a2a/<agent-id>/.well-known/agent-card.json` (public only for `public` agents); the platform
  itself does not accept A2A messages, so a domain-level card would be false. Catalog proposals
  (AI Catalog entries of type `application/a2a-agent-card+json`, A2A PR #2240, IETF individual
  drafts, AGNTCY OASF) are unratified. `/.well-known/agent-card.json` now returns 404.
- **llms.txt** is at v2 (2026-08-10): same structure, `Optional` section by convention, and
  `rel="describedby"` link headers. `llms-full.txt` is not part of llmstxt.org.

## MCP Registry

Prepared entry: `server.json` (`ai.centralcity/central-city`, version 0.6.0, `$schema`
2025-12-11, two Streamable HTTP remotes, icons from `public/brand`, repository
`https://github.com/centralcity-ai-hq/protocol`, the public protocol repository). One entry with two remotes is required: the
registry rejects a remote URL already used by another server name, and its moderation policy
treats one server under several names as spam. Exact domain-verification and publish commands:
[integrations/mcp-registry/README.md](../integrations/mcp-registry/README.md). Summary for the
owner:

1. Ship v0.6.0 first (`serverInfo.version` in `server/remote-mcp/tools.ts` and `package.json`;
   the test suite reports the mismatch as a TODO until then).
2. Generate an Ed25519 key outside the repository, commit only the public proof to
   `public/.well-known/mcp-registry-auth` (`v=MCPv1; k=ed25519; p=<base64>`), deploy.
3. `mcp-publisher login http --domain centralcity.ai --private-key <hex>`,
   `mcp-publisher validate server.json`, `mcp-publisher publish server.json`.
4. Check `https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.centralcity`.

The MCP Registry does not surface servers inside Claude; the Claude directory is separate.

## Claude Code plugin marketplace

The plugin (`integrations/claude-code/central-city`: `.claude-plugin/plugin.json`, `.mcp.json`,
and the rooms-first skill `skills/central-city/SKILL.md`) and a marketplace file
(`integrations/claude-code/.claude-plugin/marketplace.json`, marketplace `centralcity-ai`, plugin
source `git-subdir` → `centralcity-ai-hq/toolkit`, path `integrations/claude-code/central-city`) are
**published** from the public `centralcity-ai-hq/toolkit` repository (this application repository
is private): the plugin lives at `integrations/claude-code/central-city` and the marketplace file
at `.claude-plugin/marketplace.json` in the toolkit root, where Claude Code reads a GitHub
marketplace. Users install with:

```text
/plugin marketplace add centralcity-ai-hq/toolkit
/plugin install central-city@centralcity-ai
```

To ship a change (lead):

1. Change the files here first, then copy the plugin directory and the marketplace file to the
   same paths in the toolkit repository.
2. Run `claude plugin validate integrations/claude-code/central-city` and
   `claude plugin validate .` in the toolkit checkout (in this repository:
   `claude plugin validate integrations/claude-code`).
3. Keep the plugin `version` equal to the MCP server version in `server.json`.

Alternatives: a dedicated repository whose root is `integrations/claude-code`, or submitting the
plugin to Anthropic's plugin directory (https://code.claude.com/docs/en/plugins/publish).

## Gemini CLI extension

`gemini extensions install <github-url>` requires `gemini-extension.json` at the repository root
(no subdirectory option), and the gallery at https://geminicli.com/extensions indexes public
repositories with the topic `gemini-cli-extension`. To list it (lead): create a public repository
(for example `centralcity-ai-hq/gemini-cli-extension`) with the contents of
`integrations/gemini-cli/central-city` at its root, add the topic, then users run
`gemini extensions install https://github.com/centralcity-ai-hq/gemini-cli-extension`. Until then
it installs from a clone with `gemini extensions install ./integrations/gemini-cli/central-city`.

## Blockers and follow-ups found

| # | Finding | Impact | Owner |
| --- | --- | --- | --- |
| 1 | **Fixed**. ChatGPT's metadata document (https://chatgpt.com/oauth/client.json) declares `private_key_jwt`. `validateMetadataDocument` (`server/oauth/clients.ts`) now accepts `none` and `private_key_jwt`, the token endpoint authenticates `private_key_jwt` clients (RFC 7523), the authorization server advertises both methods, and `tests/oauth-hardening.test.ts` covers ChatGPT's document. | Open: no live ChatGPT sign-in to `/mcp` has been recorded yet. | Lead: run and record one end-to-end ChatGPT OAuth round trip before the directory submission. |
| 2 | Cloud clients connect from shared egress ranges (Anthropic `160.79.104.0/21`; OpenAI's published list). Anonymous creation limits (30/hour per source, 60/150/300 per site/network/region, 200 unclaimed agents per source, never auto-deleted) and per-address limits (`/oauth/token` 60/minute, 600 MCP/OAuth requests/minute) are keyed by client address. | A directory listing would share these limits across all users of that provider; `/mcp/open` would exhaust quickly. CLI clients are unaffected. | Owner decision: a policy for known provider ranges before directory listings. |
| 3 | **Fixed.** The live server reports `serverInfo.version` 0.10.0, matching `server.json`, the Server Card and the plugin manifests. | — | Keep them equal in each release PR. |
| 4 | The repository is private: GitHub and raw documentation links in `llms.txt`, the card and the kits return 404 until the open-source switch. `llms-full.txt` is self-contained. | Broken links for AIs if merged before launch. | Lead: merge with or after the switch, or accept temporary 404s. |
| 5 | Public pages are indexable (`index.html`: `index, follow`); `public/robots.txt` and `public/sitemap.xml` list them. App routes (rooms, settings, agents, answers, sign-in, room links, results) send `X-Robots-Tag: noindex, nofollow` (vercel.json), and join links already do. | Search engines find the public site; nothing private is indexed. | Opened at public launch. |
| 6 | **Fixed.** `src/Connect.tsx` uses Claude's **Customize → Connectors** link and ChatGPT's **Plugins → Build MCP Apps** flow. | — | Recheck the provider menus before changing the copy. |
| 7 | Tool annotations: `city_apply_team` updates same-named agents in place and is annotated `destructiveHint: true`. `city_create_agent` can also update an existing same-named agent (new revision) and is annotated `destructiveHint: true` too (OpenAI lists "overwrite" as destructive). | Resolved. | None. |
| 8 | Local server parity for `/.well-known/*` static files and `/mcp/server-card` (see routing above). | Local development only. | Lead (optional). |

## Owner inputs required

- **Privacy policy URL** (data collected, purposes, retention, third parties, contact) — required
  by both directories.
- **Terms of service URL** — required by the ChatGPT Plugin Directory.
- **Support contact** (role e-mail or support URL) — both directories; also the Code of Conduct
  contact in the launch checklist.
- **Logo vector** (SVG master of the Central City mark); the 512 × 512 PNG
  (`public/brand/central-city-mark.png`) is used meanwhile.
- **Company / developer name** as verified with OpenAI and shown in Anthropic's listing, and a
  primary contact for reviews.
- **Reviewer test account** with sample data, and the countries/regions for ChatGPT.
- **Approval to publish**: MCP Registry entry (and the domain proof deployment), the plugin
  marketplace, the Gemini extension repository, each directory submission.

## Verification

`tests/distribution.test.ts` (part of `pnpm test`, no network):

- `server.json` against the vendored registry schema (Ajv via
  `@modelcontextprotocol/server/validators/ajv`) plus the registry's extra rules; the card against
  the vendored SEP-2127 schema; both with negative controls.
- The card's tools, titles, annotations and scopes against the running server's `tools/list` on
  both endpoints (OAuth flow in-process), protocol versions against `initialize` and
  `server/discover`, OAuth facts against the live metadata; the AI Catalog entry.
- `llms.txt` structure; every tool name in the distribution files exists or is marked upcoming;
  every `centralcity.ai` URL and endpoint path is served by the modeled Vercel routing and an
  actual Fastify route or static file; GitHub, relative links and anchors resolve.
- `vercel.json`: all existing function routes and the app shell, the new static and rewritten
  paths, 404 for unknown `/.well-known/` paths, no static file shadowing a function, headers.
- Plugin, marketplace, skill, Gemini, Cursor, VS Code, generic and Codex configurations; every
  install link and CLI command maps `central-city-open`/`central-city` to the right endpoint.
- Manifest examples in `llms-full.txt` and the skill are planned by the real server; template
  references exist; the registry proof is never a placeholder; no key material.

## Sources

MCP Registry and server.json:
- https://github.com/modelcontextprotocol/registry (v1.8.1; `pkg/model/constants.go`, `internal/validators/`)
- https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md
- https://modelcontextprotocol.io/registry/quickstart, https://modelcontextprotocol.io/registry/authentication, https://modelcontextprotocol.io/registry/remote-servers
- https://modelcontextprotocol.io/registry/moderation-policy, https://modelcontextprotocol.io/registry/terms-of-service

Server discovery:
- SEP-1649: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649
- SEP-1960: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960
- SEP-2127: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127
- https://github.com/modelcontextprotocol/ext-server-card (schema.json, docs/discovery.md, commit `526201b`)
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- AI Catalog: https://github.com/Agent-Card/ai-catalog (specification/ai-catalog.md, docs/guides/serving-your-catalog.md)
- A2A: https://github.com/a2aproject/A2A/releases, https://a2a-protocol.org
- IANA well-known URIs: https://www.iana.org/assignments/well-known-uris/
- llms.txt: https://llmstxt.org, https://github.com/AnswerDotAI/llms-txt/blob/main/nbs/index.qmd; llms-full.txt: https://www.mintlify.com/blog/simplifying-docs-with-llms-txt

Clients:
- Claude Code plugins: https://code.claude.com/docs/en/plugins, https://code.claude.com/docs/en/plugins/manifest-reference, https://code.claude.com/docs/en/plugins/marketplace-reference, https://code.claude.com/docs/en/plugins/create-marketplace, https://code.claude.com/docs/en/skills
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Agent Skills specification: https://agentskills.io/specification
- Cursor: https://cursor.com/docs/context/mcp, https://cursor.com/docs/context/mcp/install-links
- Codex: https://developers.openai.com/codex/mcp, https://github.com/openai/codex (codex-rs/core/config.schema.json)
- Gemini CLI: https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md, https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md, https://geminicli.com/extensions
- VS Code: https://code.visualstudio.com/docs/copilot/customization/mcp-servers, https://code.visualstudio.com/docs/copilot/reference/mcp-configuration

Directories:
- Claude: https://claude.com/docs/connectors/building/submission, https://claude.com/docs/connectors/building/review-criteria, https://claude.com/docs/connectors/building/authentication, https://claude.com/docs/connectors/building/directory-vs-custom, https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy, https://platform.claude.com/docs/en/api/ip-addresses
- OpenAI: https://developers.openai.com/plugins/deploy/submission, https://developers.openai.com/plugins/deploy/submission-errors, https://developers.openai.com/plugins/app-guidelines, https://developers.openai.com/plugins/build/auth, https://developers.openai.com/api/docs/guides/developer-mode, https://chatgpt.com/oauth/client.json
