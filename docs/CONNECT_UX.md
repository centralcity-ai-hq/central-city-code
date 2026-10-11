# Provider-first connection setup

The public `/#connect` page and signed-in connection panel share `ConnectAI`. The initial screen offers ChatGPT, Claude, Cursor, Codex and Claude Code. Technical details stay collapsed. The selected provider opens a native modal with two explicit access choices: public trial (`/mcp/open`) or account workspace (`/mcp`). Every setup starts with public trial; reopening clears the previous selection.

Opening a provider, copying instructions or advancing to the first task is **not connection verification**. The UI has no connected badge or success counter. The first task asks the provider to call Central City and plan only, without creating agents. Public trial itself can create unclaimed teams; it cannot read an existing private workspace.

## Provider behavior

| Client      | Primary action                           | Remaining user action                                                                         |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Claude web  | Official prefilled custom connector link | Review/add in Claude; approve OAuth for workspace access                                      |
| ChatGPT     | Open Plugins and show guided setup       | Add → Create MCP App, enter URL with no authentication, review/create/install, enable in chat |
| Cursor      | Official MCP installation deep link      | Installed Cursor opens; user confirms server and authenticates if needed                      |
| Codex       | App settings steps and one copyable URL  | Add Streamable HTTP server, save/restart if requested; authenticate for workspace             |
| Claude Code | Published plugin (two commands); `claude mcp add` as the alternative | Run in Claude Code; authenticate through `/mcp` for workspace |
| Gemini CLI  | Published extension (one command); `gemini mcp add` as the alternative | Run in a terminal; `/mcp auth central-city` for workspace |

ChatGPT workspace access: the backend now accepts ChatGPT's `private_key_jwt` client metadata document (with security regression coverage in `tests/oauth-hardening.test.ts`). A real ChatGPT OAuth round trip has not been recorded yet, so the guided ChatGPT setup still uses `/mcp/open` without authentication; offer workspace sign-in from ChatGPT only after that round trip is recorded. Do not infer that the browser-link tests verify a provider connection.

Cloud-client setup from loopback directs users to the live site. Copyable manual fallback remains in provider help. Advanced setup preserves both endpoint addresses, a fresh UUID-keyed REST example and Agent Card discovery. Claim actions still route to sign-in or the existing signed-in claim panel.

## Accessibility and presentation

Native dialog supplies modal focus containment and Escape dismissal. The heading receives focus on step transitions; closing returns focus to the initiating provider button. Provider choices, radio inputs, native disclosures and copy controls are keyboard accessible. Scoped CSS uses existing theme tokens, stacks at narrow widths and respects reduced motion. The first screen has no expanded commands or permission tables.

## Verification

`e2e/connect.spec.ts` covers the landing route, provider selection, public/workspace URL switching, clipboard output, Cursor payload, Claude prefilled URL, ChatGPT limitations, local cloud-client warning, forward/back focus, Escape/opener restoration, mobile overflow, REST creation and signed-in claiming. Hosted-origin tests proxy synthetic local data under `centralcity.test`; they never contact provider accounts. Actual provider installation/authentication remains a separate release check.

## Official references checked 2026-09-26

- [Claude custom connector URL](https://claude.com/docs/connectors/building/directory-vs-custom)
- [Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)
- [ChatGPT plugin quickstart](https://developers.openai.com/plugins/quickstart)
- [Connect ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [ChatGPT authentication](https://developers.openai.com/plugins/build/auth)
- [Cursor install links](https://prod.cursor.com/docs/mcp/install-links)
- [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)

Provider menus and account eligibility can change. Recheck these sources before modifying instructions; do not invent a one-click installation endpoint.

## Live UI review follow-up

On 2026-09-26 the team inspected the signed-in ChatGPT web UI without changing settings or submitting a connector. `/plugins` exposes **Add → Create MCP App**. The form has Name, Server URL, and Authentication including No authentication, plus a trust warning and acknowledgment. The inspected Security and login page did not show a Developer mode toggle, and the form was reachable without changing settings. Instructions now follow the observed route instead of requiring that toggle. Account/workspace differences remain possible. Creation, installation and an actual tool call were not performed; this evidence verifies navigation and fields only. Code samples now use a labelled `group` role for valid accessible names.
