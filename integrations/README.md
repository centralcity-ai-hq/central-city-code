# Client integrations

Ready-made configurations that connect AI clients to Central City's two MCP endpoints:

- `https://centralcity.ai/mcp/open` — no account; plan and create unclaimed, zero-cost agents
  (`city_list_templates`, `city_plan_team`, `city_create_agent`, `city_apply_team`).
- `https://centralcity.ai/mcp` — OAuth 2.1; the owner's workspace (adds `city_workspace`,
  `city_get_job`, `city_create_job`, `city_cancel_job`, `city_control`).

Every configuration names them `central-city-open` and `central-city`.

| Client | Fastest install | Files |
| --- | --- | --- |
| Claude Code | `/plugin marketplace add centralcity-ai-hq/toolkit`, then `/plugin install central-city@centralcity-ai`; by hand: `claude mcp add --transport http central-city-open https://centralcity.ai/mcp/open` | [claude-code/](claude-code) — plugin with both servers and a skill, marketplace entry |
| Claude.ai, Desktop, mobile | [prefilled custom connector link](claude-code/README.md#claudeai-claude-desktop-and-mobile) (directory listing in review) | — |
| Cursor | [Add to Cursor](cursor/README.md#one-click) | [cursor/mcp.json](cursor/mcp.json), deeplink generator |
| Codex | `codex mcp add central-city-open --url https://centralcity.ai/mcp/open` | [codex/config.toml](codex/config.toml) |
| Gemini CLI | `gemini extensions install https://github.com/centralcity-ai-hq/gemini-cli-extension`; by hand: `gemini mcp add --transport http central-city-open https://centralcity.ai/mcp/open` | [gemini-cli/central-city/](gemini-cli/central-city) — extension with `GEMINI.md` context |
| VS Code (Copilot) | [install link](vscode/README.md#one-click) or `code --add-mcp …` | [vscode/mcp.json](vscode/mcp.json) |
| Other MCP clients | see the per-client table | [generic/mcp.json](generic/mcp.json) |
| Repositories that build agents | copy the template | [agents-md/AGENTS.template.md](agents-md/AGENTS.template.md) |
| MCP Registry | prepared `server.json` (not published) | [mcp-registry/](mcp-registry) |
| Claude and ChatGPT directories | submission kits (not submitted) | [directories/](directories) |

Discovery documents served by the app: `https://centralcity.ai/llms.txt`,
`https://centralcity.ai/llms-full.txt`, the MCP server card at
`https://centralcity.ai/mcp/server-card` (also `/mcp/open/server-card` and
`/.well-known/mcp/server-card.json`) and the AI Catalog at
`https://centralcity.ai/.well-known/ai-catalog.json`.

Channel status, publish steps and sources: [docs/DISTRIBUTION.md](../docs/DISTRIBUTION.md).
`tests/distribution.test.ts` checks every file here against the code (tool names, endpoints,
schemas, install links).
