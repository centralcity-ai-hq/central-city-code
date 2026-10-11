# Third-party licences

Review date: 2026-09-30, against `pnpm-lock.yaml` at application v0.7.0 (base `deeb6bb`).
Central City is distributed under Apache-2.0. Dependencies are **not vendored**: they are
installed from the npm registry, and the production frontend bundle (`dist/`) includes
compiled code from React, React DOM, scheduler, lucide-react, the Markdown parser
(`mdast-util-*`, `micromark-*`) and code highlighting (`lowlight`, `highlight.js`).

Method: `pnpm licenses list --json` (all) and `--prod` (pnpm 11.19.0), on macOS arm64, cross-checked
against the `packages:` section of `pnpm-lock.yaml`. Re-run the same commands after any
dependency change and update this file in the same pull request.

## Result

**No GPL, LGPL, AGPL, SSPL, BUSL/Commons Clause, "unknown" or unlicensed package** is present
in production or development dependencies. Nothing blocks Apache-2.0 distribution.

| Scope                  | Packages | Licences                                                           |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| Production (`--prod`)  | 155      | MIT 136, ISC 7, BSD-3-Clause 6, BlueOak-1.0.0 5, Apache-2.0 1      |
| Development only       | 43       | MIT 31, Apache-2.0 6, ISC 3, MPL-2.0 2, BSD-3-Clause 1             |
| Platform-only variants | 68       | Not installed on macOS arm64; same licence as their parent (below) |

All of MIT, ISC, BSD-3-Clause, BlueOak-1.0.0 and Apache-2.0 are permissive and compatible with
Apache-2.0 distribution; keep their copyright/licence notices when redistributing bundles.

## Items noted for review

| Package                                                            | Licence                            | Scope | Assessment                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lightningcss` 1.33.0 and its platform binaries (`lightningcss-*`) | MPL-2.0                            | dev   | Weak, file-level copyleft. Used only as a build tool by Vite; not shipped in `dist/` or the server. Compatible (unmodified use). If its files are ever modified or vendored, publish those changes under MPL-2.0. |
| `@electric-sql/pglite` 0.5.8                                       | Apache-2.0 (or PostgreSQL License) | prod  | Dual-licensed; contains a WebAssembly PostgreSQL build under the PostgreSQL License (permissive). Attribution added to `NOTICE`.                                                                                  |
| `lucide-react` 1.48.0                                              | ISC                                | prod  | Icons shipped in the frontend bundle. Permissive; parts derive from Feather (MIT).                                                                                                                                |
| `highlight.js` 11.11.2 and 11.12.0 (via `lowlight`)                | BSD-3-Clause                       | prod  | Code highlighting shipped in the frontend bundle. Permissive; keep its notice when redistributing bundles.                                                                                                        |
| `glob`, `lru-cache`, `minimatch`, `minipass`, `path-scurry`        | BlueOak-1.0.0                      | prod  | Permissive (patent grant, notice-only). Server-side transitive dependencies of Fastify static serving.                                                                                                            |
| `playwright`, `playwright-core`, `@playwright/test`                | Apache-2.0                         | dev   | Test tooling only. Browser binaries downloaded by Playwright have their own licences and are not distributed by this project.                                                                                     |
| `typescript` 7.0.2 and `@typescript/typescript-*` native binaries  | Apache-2.0                         | dev   | Build tooling only.                                                                                                                                                                                               |
| `fsevents` 2.3.3                                                   | MIT                                | dev   | macOS-only optional dependency; installed on macOS only.                                                                                                                                                          |

### Vendored assets

| Asset                                                             | Source                                                                                | Licence | Notes                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude, Claude Code and Cursor brand marks (`src/brandMarks.tsx`) | [Simple Icons](https://simpleicons.org) 16.34.0, path data copied (no npm dependency) | CC0-1.0 | Used only to name the app on the Connect AI cards; the marks remain trademarks of their owners. OpenAI (ChatGPT, Codex) and Microsoft (VS Code) marks are not in Simple Icons, so those cards keep neutral icons. |

Platform-only packages that were not installed during this review (only the macOS arm64
variants were), with the licence of their package family: `@esbuild/*` (MIT),
`@rolldown/binding-*` (MIT), `@typescript/typescript-*` (Apache-2.0), `lightningcss-*` (MPL-2.0).

External tools used by CI but not dependencies: Gitleaks 8.30.1 (MIT, downloaded and
checksum-verified at run time), GitHub Actions `actions/checkout`, `actions/setup-node`,
`pnpm/action-setup` (MIT). Optional local model runtimes and weights described in
`docs/LOCAL_MODEL.md` are user-supplied and not distributed.

## Full inventory

### Production

| Package                                           | Version | Licence       | Direct |
| ------------------------------------------------- | ------- | ------------- | ------ |
| @electric-sql/pglite                              | 0.5.8   | Apache-2.0    | yes    |
| @fastify/accept-negotiator                        | 2.1.0   | MIT           |        |
| @fastify/ajv-compiler                             | 4.0.6   | MIT           |        |
| @fastify/cookie                                   | 11.1.2  | MIT           | yes    |
| @fastify/error                                    | 4.2.0   | MIT           |        |
| @fastify/fast-json-stringify-compiler             | 5.1.0   | MIT           |        |
| @fastify/forwarded                                | 3.0.2   | MIT           |        |
| @fastify/merge-json-schemas                       | 0.2.1   | MIT           |        |
| @fastify/proxy-addr                               | 5.1.1   | MIT           |        |
| @fastify/send                                     | 4.1.1   | MIT           |        |
| @fastify/static                                   | 10.1.5  | MIT           | yes    |
| @lukeed/ms                                        | 2.0.2   | MIT           |        |
| @modelcontextprotocol/core                        | 2.1.0   | MIT           |        |
| @modelcontextprotocol/server                      | 2.1.0   | MIT           | yes    |
| @pinojs/redact                                    | 0.4.0   | MIT           |        |
| @types/debug                                      | 4.1.13  | MIT           |        |
| @types/hast                                       | 3.0.5   | MIT           |        |
| @types/mdast                                      | 4.0.4   | MIT           |        |
| @types/ms                                         | 2.1.0   | MIT           |        |
| @types/unist                                      | 3.0.3   | MIT           |        |
| abstract-logging                                  | 2.0.1   | MIT           |        |
| ajv                                               | 8.20.0  | MIT           |        |
| ajv-formats                                       | 3.0.1   | MIT           |        |
| atomic-sleep                                      | 1.0.0   | MIT           |        |
| avvio                                             | 9.3.0   | MIT           |        |
| balanced-match                                    | 4.0.4   | MIT           |        |
| brace-expansion                                   | 5.0.12  | MIT           |        |
| ccount                                            | 2.0.1   | MIT           |        |
| character-entities                                | 2.0.2   | MIT           |        |
| content-disposition                               | 3.0.0   | MIT           |        |
| cookie                                            | 1.1.1   | MIT           |        |
| cookie                                            | 2.0.1   | MIT           |        |
| debug                                             | 4.4.3   | MIT           |        |
| decode-named-character-reference                  | 1.3.0   | MIT           |        |
| depd                                              | 2.0.0   | MIT           |        |
| dequal                                            | 2.0.3   | MIT           |        |
| devlop                                            | 1.1.0   | MIT           |        |
| escape-html                                       | 1.0.3   | MIT           |        |
| escape-string-regexp                              | 5.0.0   | MIT           |        |
| fast-decode-uri-component                         | 1.0.1   | MIT           |        |
| fast-deep-equal                                   | 3.1.3   | MIT           |        |
| fast-json-stringify                               | 7.0.1   | MIT           |        |
| fast-querystring                                  | 1.1.2   | MIT           |        |
| fast-uri                                          | 3.1.8   | BSD-3-Clause  |        |
| fast-uri                                          | 4.2.1   | BSD-3-Clause  |        |
| fastify                                           | 5.12.5  | MIT           | yes    |
| fastify-plugin                                    | 6.0.0   | MIT           |        |
| fastq                                             | 1.20.3  | ISC           |        |
| find-my-way                                       | 9.9.0   | MIT           |        |
| glob                                              | 13.0.6  | BlueOak-1.0.0 |        |
| highlight.js                                      | 11.11.2 | BSD-3-Clause  | yes    |
| highlight.js                                      | 11.12.0 | BSD-3-Clause  | yes    |
| http-errors                                       | 2.0.1   | MIT           |        |
| inherits                                          | 2.0.4   | ISC           |        |
| ipaddr.js                                         | 2.5.0   | MIT           |        |
| json-schema-ref-resolver                          | 3.0.0   | MIT           |        |
| json-schema-traverse                              | 1.0.0   | MIT           |        |
| light-my-request                                  | 6.6.0   | BSD-3-Clause  |        |
| longest-streak                                    | 3.1.0   | MIT           |        |
| lowlight                                          | 3.3.0   | MIT           | yes    |
| lru-cache                                         | 11.5.3  | BlueOak-1.0.0 |        |
| lucide-react                                      | 1.48.0  | ISC           | yes    |
| markdown-table                                    | 3.0.4   | MIT           |        |
| mdast-util-find-and-replace                       | 3.0.2   | MIT           |        |
| mdast-util-from-markdown                          | 2.0.3   | MIT           | yes    |
| mdast-util-gfm                                    | 3.1.0   | MIT           | yes    |
| mdast-util-gfm-autolink-literal                   | 2.0.1   | MIT           |        |
| mdast-util-gfm-footnote                           | 2.1.0   | MIT           |        |
| mdast-util-gfm-strikethrough                      | 2.0.0   | MIT           |        |
| mdast-util-gfm-table                              | 2.0.0   | MIT           |        |
| mdast-util-gfm-task-list-item                     | 2.0.0   | MIT           |        |
| mdast-util-phrasing                               | 4.1.0   | MIT           |        |
| mdast-util-to-markdown                            | 2.1.2   | MIT           |        |
| mdast-util-to-string                              | 4.0.0   | MIT           |        |
| micromark                                         | 4.0.3   | MIT           |        |
| micromark-core-commonmark                         | 2.0.4   | MIT           |        |
| micromark-extension-gfm                           | 3.0.0   | MIT           | yes    |
| micromark-extension-gfm-autolink-literal          | 2.1.0   | MIT           |        |
| micromark-extension-gfm-footnote                  | 2.1.0   | MIT           |        |
| micromark-extension-gfm-strikethrough             | 2.1.0   | MIT           |        |
| micromark-extension-gfm-table                     | 2.1.2   | MIT           |        |
| micromark-extension-gfm-tagfilter                 | 2.0.0   | MIT           |        |
| micromark-extension-gfm-task-list-item            | 2.1.0   | MIT           |        |
| micromark-factory-destination                     | 2.0.1   | MIT           |        |
| micromark-factory-label                           | 2.0.1   | MIT           |        |
| micromark-factory-space                           | 2.1.0   | MIT           |        |
| micromark-factory-title                           | 2.0.1   | MIT           |        |
| micromark-factory-whitespace                      | 2.0.1   | MIT           |        |
| micromark-util-character                          | 2.1.1   | MIT           |        |
| micromark-util-chunked                            | 2.0.1   | MIT           |        |
| micromark-util-classify-character                 | 2.0.1   | MIT           |        |
| micromark-util-combine-extensions                 | 2.0.1   | MIT           |        |
| micromark-util-decode-numeric-character-reference | 2.0.2   | MIT           |        |
| micromark-util-decode-string                      | 2.0.1   | MIT           |        |
| micromark-util-edit-map                           | 1.0.0   | MIT           |        |
| micromark-util-encode                             | 2.0.1   | MIT           |        |
| micromark-util-html-tag-name                      | 2.0.1   | MIT           |        |
| micromark-util-normalize-identifier               | 2.0.1   | MIT           |        |
| micromark-util-resolve-all                        | 2.0.1   | MIT           |        |
| micromark-util-sanitize-uri                       | 2.0.1   | MIT           |        |
| micromark-util-subtokenize                        | 2.1.0   | MIT           |        |
| micromark-util-symbol                             | 2.0.1   | MIT           |        |
| micromark-util-types                              | 2.0.3   | MIT           |        |
| mime                                              | 3.0.0   | MIT           |        |
| minimatch                                         | 10.2.6  | BlueOak-1.0.0 |        |
| minipass                                          | 7.1.3   | BlueOak-1.0.0 |        |
| ms                                                | 2.1.3   | MIT           |        |
| on-exit-leak-free                                 | 2.1.2   | MIT           |        |
| path-scurry                                       | 2.0.2   | BlueOak-1.0.0 |        |
| pg                                                | 8.23.0  | MIT           | yes    |
| pg-cloudflare                                     | 1.4.0   | MIT           |        |
| pg-connection-string                              | 2.14.0  | MIT           |        |
| pg-int8                                           | 1.0.1   | ISC           |        |
| pg-pool                                           | 3.14.0  | MIT           |        |
| pg-protocol                                       | 1.16.0  | MIT           |        |
| pg-types                                          | 2.2.0   | MIT           |        |
| pgpass                                            | 1.0.5   | MIT           |        |
| pino                                              | 10.3.1  | MIT           |        |
| pino-abstract-transport                           | 3.0.0   | MIT           |        |
| pino-std-serializers                              | 7.1.0   | MIT           |        |
| postgres-array                                    | 2.0.0   | MIT           |        |
| postgres-bytea                                    | 1.0.1   | MIT           |        |
| postgres-date                                     | 1.0.7   | MIT           |        |
| postgres-interval                                 | 1.2.0   | MIT           |        |
| process-warning                                   | 4.0.1   | MIT           |        |
| process-warning                                   | 5.1.0   | MIT           |        |
| qrcode-generator                                  | 1.4.4   | MIT           | yes    |
| quick-format-unescaped                            | 4.0.4   | MIT           |        |
| react                                             | 19.3.0  | MIT           | yes    |
| react-dom                                         | 19.3.0  | MIT           | yes    |
| real-require                                      | 0.2.0   | MIT           |        |
| real-require                                      | 1.0.0   | MIT           |        |
| require-from-string                               | 2.0.2   | MIT           |        |
| ret                                               | 0.5.0   | MIT           |        |
| reusify                                           | 1.1.0   | MIT           |        |
| rfdc                                              | 1.4.1   | MIT           |        |
| safe-regex2                                       | 5.1.1   | MIT           |        |
| safe-stable-stringify                             | 2.5.0   | MIT           |        |
| scheduler                                         | 0.28.0  | MIT           |        |
| secure-json-parse                                 | 4.1.0   | BSD-3-Clause  |        |
| semver                                            | 7.8.5   | ISC           |        |
| set-cookie-parser                                 | 2.7.2   | MIT           |        |
| setprototypeof                                    | 1.2.0   | ISC           |        |
| sonic-boom                                        | 4.2.1   | MIT           |        |
| split2                                            | 4.2.0   | ISC           |        |
| statuses                                          | 2.0.2   | MIT           |        |
| thread-stream                                     | 4.2.0   | MIT           |        |
| toad-cache                                        | 3.7.4   | MIT           |        |
| toidentifier                                      | 1.0.1   | MIT           |        |
| unist-util-is                                     | 6.0.1   | MIT           |        |
| unist-util-stringify-position                     | 4.0.0   | MIT           |        |
| unist-util-visit                                  | 5.1.0   | MIT           |        |
| unist-util-visit-parents                          | 6.0.2   | MIT           |        |
| xtend                                             | 4.0.2   | MIT           |        |
| zod                                               | 4.6.5   | MIT           | yes    |
| zwitch                                            | 2.0.4   | MIT           |        |

### Development only

| Package                             | Version | Licence      | Direct |
| ----------------------------------- | ------- | ------------ | ------ |
| @esbuild/darwin-arm64               | 0.28.2  | MIT          |        |
| @modelcontextprotocol/client        | 2.1.0   | MIT          | yes    |
| @oxc-project/types                  | 0.151.0 | MIT          |        |
| @playwright/test                    | 1.63.0  | Apache-2.0   | yes    |
| @rolldown/binding-darwin-arm64      | 1.2.11  | MIT          |        |
| @rolldown/pluginutils               | 1.0.1   | MIT          |        |
| @types/node                         | 26.6.3  | MIT          | yes    |
| @types/pg                           | 8.23.1  | MIT          | yes    |
| @types/react                        | 19.3.0  | MIT          | yes    |
| @types/react-dom                    | 19.3.0  | MIT          | yes    |
| @typescript/typescript-darwin-arm64 | 7.0.2   | Apache-2.0   |        |
| @vitejs/plugin-react                | 6.1.1   | MIT          | yes    |
| cross-spawn                         | 7.0.6   | MIT          |        |
| csstype                             | 3.2.3   | MIT          |        |
| detect-libc                         | 2.1.2   | Apache-2.0   |        |
| esbuild                             | 0.28.2  | MIT          |        |
| eventsource                         | 3.0.7   | MIT          |        |
| eventsource-parser                  | 3.1.1   | MIT          |        |
| fdir                                | 6.5.0   | MIT          |        |
| fsevents                            | 2.3.3   | MIT          |        |
| isexe                               | 2.0.0   | ISC          |        |
| jose                                | 6.2.12  | MIT          |        |
| lightningcss                        | 1.33.0  | MPL-2.0      |        |
| lightningcss-darwin-arm64           | 1.33.0  | MPL-2.0      |        |
| nanoid                              | 3.3.19  | MIT          |        |
| path-key                            | 3.1.1   | MIT          |        |
| picocolors                          | 1.1.1   | ISC          |        |
| picomatch                           | 4.0.7   | MIT          |        |
| pkce-challenge                      | 5.0.1   | MIT          |        |
| playwright                          | 1.63.0  | Apache-2.0   |        |
| playwright-core                     | 1.63.0  | Apache-2.0   |        |
| postcss                             | 8.5.28  | MIT          |        |
| prettier                            | 3.9.9   | MIT          | yes    |
| rolldown                            | 1.2.11  | MIT          |        |
| shebang-command                     | 2.0.0   | MIT          |        |
| shebang-regex                       | 3.0.0   | MIT          |        |
| source-map-js                       | 1.2.1   | BSD-3-Clause |        |
| tinyglobby                          | 0.2.17  | MIT          |        |
| tsx                                 | 4.23.15 | MIT          | yes    |
| typescript                          | 7.0.2   | Apache-2.0   | yes    |
| undici-types                        | 8.9.0   | MIT          |        |
| vite                                | 8.3.1   | MIT          | yes    |
| which                               | 2.0.2   | ISC          |        |
