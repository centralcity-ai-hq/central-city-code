# Claude Code and Claude apps

## Install: the published plugin

In Claude Code (both servers and the `central-city` skill):

```text
/plugin marketplace add centralcity-ai-hq/toolkit
/plugin install central-city@centralcity-ai
```

Then run `/mcp`, choose `plugin:central-city:central-city` and choose **Authenticate** to use your
own workspace; `central-city-open` needs no sign-in. Details below.

## By hand: one command

```sh
# No account: plan and create unclaimed, zero-cost agents
claude mcp add --transport http central-city-open https://centralcity.ai/mcp/open

# Your own workspace over OAuth: add it, then run /mcp in Claude Code and choose Authenticate
claude mcp add --transport http central-city https://centralcity.ai/mcp
```

Add `--scope user` to make a server available in every project, or `--scope project` to write
it to the repository's `.mcp.json` for your team. `claude mcp login central-city` also starts the
OAuth sign-in outside a session.

## Plugin (servers + skill)

`central-city/` is a Claude Code plugin. It bundles both MCP servers (`.mcp.json`) and the
`central-city` skill (`skills/central-city/SKILL.md`), which teaches Claude how to plan and apply
teams, hand over claim links and write good `centralcity.agent/v1` manifests.

| File | Purpose |
| --- | --- |
| `central-city/.claude-plugin/plugin.json` | Plugin manifest (name `central-city`) |
| `central-city/.mcp.json` | `central-city-open` (no auth) and `central-city` (OAuth) HTTP servers |
| `central-city/skills/central-city/SKILL.md` | The skill, invocable as `/central-city:central-city` |
| `.claude-plugin/marketplace.json` | Marketplace `centralcity-ai` listing the plugin with a `git-subdir` source |

Try it locally without any marketplace:

```sh
claude --plugin-dir integrations/claude-code/central-city
claude plugin validate integrations/claude-code/central-city
claude plugin validate integrations/claude-code
```

The marketplace is published from the public `centralcity-ai-hq/toolkit` repository (see
[docs/DISTRIBUTION.md](../../docs/DISTRIBUTION.md#claude-code-plugin-marketplace); Claude Code
reads a GitHub marketplace from the repository root). Users install in Claude Code with:

```text
/plugin marketplace add centralcity-ai-hq/toolkit
/plugin install central-city@centralcity-ai
```

The plugin's HTTP servers appear in `/mcp` as `plugin:central-city:central-city-open` and
`plugin:central-city:central-city`. The OAuth server shows **Needs authentication** until the
user signs in there; nothing in the plugin contains a credential.

## Claude.ai, Claude Desktop and mobile

Central City's listing in Claude's connector directory is in review (no link yet). Until then,
custom connectors are added under **Customize → Connectors → Add custom connector** (Team and
Enterprise Owners: **Organization settings → Connectors**). These links open the dialog with the
name and URL prefilled; the user still reviews and confirms:

- No account: https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Central%20City%20(no%20account)&connectorUrl=https%3A%2F%2Fcentralcity.ai%2Fmcp%2Fopen
- OAuth: https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Central%20City&connectorUrl=https%3A%2F%2Fcentralcity.ai%2Fmcp

Choose no authentication for `/mcp/open`. For `/mcp`, Claude signs in with its published client
metadata document or dynamic client registration; no client ID or secret is needed. Claude Code
picks up connectors added on claude.ai automatically.
