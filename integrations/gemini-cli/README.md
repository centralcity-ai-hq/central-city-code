# Gemini CLI

## Install: the published extension

```sh
gemini extensions install https://github.com/centralcity-ai-hq/gemini-cli-extension
```

It adds both servers (`central-city-open`, no account; `central-city`, OAuth) and the
`GEMINI.md` context. To use your own workspace, run `/mcp auth central-city` in Gemini CLI.

## By hand: one command

```sh
gemini mcp add --transport http central-city-open https://centralcity.ai/mcp/open
gemini mcp add --transport http central-city https://centralcity.ai/mcp   # OAuth; /mcp auth central-city
```

`gemini mcp add` writes to the project's `.gemini/settings.json`; add `-s user` for
`~/.gemini/settings.json`.

## Extension (servers + context)

[`central-city/`](central-city) is a Gemini CLI extension: `gemini-extension.json` declares both
servers with `httpUrl` (Streamable HTTP; accepted by current and older Gemini CLI versions) and
`GEMINI.md` supplies the usage context.

```sh
gemini extensions install ./integrations/gemini-cli/central-city   # from a local clone
gemini extensions link ./integrations/gemini-cli/central-city      # development: live link
```

Published: `gemini extensions install https://github.com/centralcity-ai-hq/gemini-cli-extension` (that repository mirrors this folder; keep them in sync).

`gemini extensions install <github-url>` expects `gemini-extension.json` at the root of a
repository (or of a release archive); it has no subdirectory option, so the published
repository holds this folder at its root. The gallery at https://geminicli.com/extensions indexes
public repositories with the topic `gemini-cli-extension`; see
[docs/DISTRIBUTION.md](../../docs/DISTRIBUTION.md#gemini-cli-extension).

For `central-city`, Gemini CLI discovers OAuth from the `401` response (RFC 9728 metadata) and
registers itself dynamically; `/mcp auth central-city` repeats the sign-in.
