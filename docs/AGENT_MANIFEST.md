# Agent manifest `centralcity.agent/v1`

Status: Phase 2 milestone M2 (26 September 2026). M2.1 delivered the library (schema, resolver, planner, templates, Agent Card compiler/signing; `tests/manifest.test.ts`). M2 wires it into the MCP tools `city_list_templates`, `city_plan_team`, `city_create_agent` (manifest mode) and `city_apply_team`, persists applied manifests, publishes signed Agent Cards and supports anonymous, unclaimed creation (`tests/autonomous-creation.test.ts`, [REMOTE_MCP.md](REMOTE_MCP.md)).

AI clients (Claude, Codex, ChatGPT) describe what they want as a JSON manifest: one agent (`kind: Agent`) or a whole team (`kind: Team`). The server resolves templates and forks, produces a deterministic dry-run plan, and only then (after approval where required) applies it.

| Module                         | Purpose                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `shared/manifest.ts`           | Zod schemas, types, limits, URL/host checks, `parse*Manifest` with issues  |
| `server/manifest/canonical.ts` | RFC 8785 (JCS-style) canonical JSON and `sha256:` hashes                   |
| `server/manifest/templates.ts` | Versioned template registry and the built-in library                       |
| `server/manifest/resolve.ts`   | `resolveManifest` (extends/fork merge, fork policy tightening, hashing)    |
| `server/manifest/plan.ts`      | `planTeam` / `planAgent` dry-run plans                                     |
| `server/manifest/agent-card.ts`| A2A v1.0 Agent Card compiler, `signAgentCard`, `verifyAgentCard`           |
| `server/manifest/keys.ts`      | Ed25519 keys, detached JWS, JWKS export                                    |
| `server/manifest/index.ts`     | Barrel export                                                              |

## Agent manifest

```json
{
  "apiVersion": "centralcity.agent/v1",
  "kind": "Agent",
  "metadata": {
    "name": "invoice-reader",
    "displayName": "Invoice reader",
    "description": "Pulls fields out of pasted invoices.",
    "labels": { "team": "finance" }
  },
  "spec": {
    "extends": "template:extractor@1.0.0",
    "instructions": "Prefer ISO dates.",
    "policy": { "maxDepth": 1 },
    "visibility": "private"
  }
}
```

Fields (all objects reject unknown keys):

- `metadata.name` — slug `[a-z0-9-]`, at most 63 characters; the stable identity used for idempotent planning. `displayName` (≤64, defaults to the name), `description` (≤300), `labels` (≤16 slug keys → short values).
- `spec.extends` — `template:<id>@<major.minor.patch>` or `agent:<uuid>@<revision>` (fork).
- `spec.capabilities` — 1–8 unique slugs. The schema is open (extensible), but planning currently requires hosted agents to use only `research`, `extract`, `verify`, and other runtimes to list one of those first (the native store keeps a single capability).
- `spec.runtime` — `mode`: `hosted` | `external` | `a2a`; optional `model {provider: platform|anthropic|openai|byo|external, name?}`; `endpoint` (https, public host) is required for and only allowed with `a2a`. Hosted agents cannot use `external` models; non-hosted agents cannot use `platform`. `a2a` runtimes plan with a `RUNTIME_PENDING` warning because outbound A2A is not executable yet.
- `spec.instructions` — at most 8000 characters.
- `spec.skills` — at most 32, unique `id`; `{id, name, description, tags, inputModes?, outputModes?, examples?}`. Compiled directly into Agent Card skills.
- `spec.tools.mcpServers` — at most 8 `{name, url (https, public host), scopes[]}`, unique names. Declarative only: nothing connects to these servers yet.
- `spec.policy` — `budgetUsd` (0–1000, cents precision, **default 0 = zero-cost only**), `maxChildren` (0–20, default 0: the number of members this agent may connect to), `maxDepth` (0–3, default 3: longest delegation chain below the agent), `allowedDomains` (≤32 lowercase DNS names, optional `*.` prefix; empty = none), `approvalRequiredFor` (subset of `spend`, `paid-model`, `external-network`, `tool-call`, `delegation`, `publication`).
- `spec.visibility` — `private` (default) | `org` | `public`.

### URL and host rules

URLs must be `https:` without credentials or fragments, on a DNS name with at least two labels. IP literals (any form the URL parser normalizes to one, such as `2130706433` or `0x7f.1`), IPv6 literals, `localhost` and reserved or private suffixes (`.local`, `.internal`, `.home.arpa`, `.lan`, `.corp`, `.test`, `.example`, `.invalid`, `.onion`, `nip.io`, `sslip.io`, `localtest.me`, …) are rejected. These are static checks. Any future code that fetches these URLs must still resolve DNS and refuse private or loopback addresses at connection time (DNS rebinding).

### Limits

The JSON document may be at most **32 KiB** (UTF-8), checked before schema parsing; the resolved manifest is held to the same bound. Teams have at most 20 members and 100 connections; agents at most 32 skills.

## Resolution (`resolveManifest`)

```ts
resolveManifest(input: unknown, registry = builtinTemplates, loadAgent?: AgentLoader): {
  manifest: ResolvedAgentManifest; manifestHash: string; base: …
}
```

The input is parsed, the base (template or forked agent revision) loaded, and the document merged:

- objects merge key by key; **arrays replace**; scalars override; absent keys inherit;
- `metadata.name` always comes from the child, `displayName` falls back to the base, then the name;
- `spec.runtime` is replaced wholesale when the child names a different `mode`;
- the child's `spec.extends` is kept in the resolved document as provenance.

The merged document must satisfy the full schema (required capabilities and runtime, cross-field runtime rules, defaults applied). Errors are thrown as `ManifestError` with `issues: {code, path, message, hint}[]`.

**Forks.** `loadAgent(id, revision)` is synchronous: the server preloads and authorizes the revision and reports `sameOwner`. A same-owner fork overrides freely. Forking another owner's agent requires `org` or `public` visibility (`FORK_NOT_PERMITTED` otherwise) and may only **tighten**: `budgetUsd`, `maxChildren` and `maxDepth` cannot grow; `allowedDomains` must be covered by the parent's (a `*.x` parent covers subdomains, not the apex); `approvalRequiredFor` cannot drop actions; MCP servers cannot be added (matched by URL). Violations are `POLICY_LOOSENED` / `TOOLS_EXPANDED`.

**Hash.** `manifestHash = "sha256:" + hex(SHA-256(JCS(resolved)))`. Key order, omitted defaults versus explicit defaults and whitespace do not change it. Template versions are immutable, so a `template:` reference always resolves to the same content.

## Teams

```json
{
  "apiVersion": "centralcity.agent/v1",
  "kind": "Team",
  "metadata": { "name": "research-team", "displayName": "Research team" },
  "spec": {
    "coordinator": "requester",
    "members": [
      {
        "name": "requester",
        "manifest": {
          "apiVersion": "centralcity.agent/v1",
          "kind": "Agent",
          "metadata": { "name": "requester" },
          "spec": {
            "capabilities": ["research"],
            "runtime": { "mode": "external" },
            "policy": { "maxChildren": 1, "maxDepth": 2 }
          }
        }
      },
      {
        "name": "researcher",
        "manifest": {
          "apiVersion": "centralcity.agent/v1",
          "kind": "Agent",
          "metadata": { "name": "researcher" },
          "spec": { "extends": "template:research-analyst@1.0.0", "policy": { "maxChildren": 1 } }
        }
      },
      { "name": "checker", "ref": "template:fact-checker@1.0.0" }
    ],
    "connections": [
      { "from": "requester", "to": "researcher" },
      { "from": "researcher", "to": "checker" }
    ],
    "policy": { "budgetUsd": 0, "maxDepth": 2 }
  }
}
```

This is the built-in `template:research-team@1.0.0`: the whole team from one prompt. A member has exactly one of an inline `manifest` (whose `metadata.name` must equal the member name) or a `ref`, which is shorthand for `{metadata: {name}, spec: {extends: ref}}`. Connections are directional (`from` may send work to `to`). Team `policy.budgetUsd` (default 0) caps the sum of member budgets; `policy.maxDepth` (≤3, default 3) caps the chain length from the coordinator.

## Plan and apply

```ts
planTeam(input: unknown, context: PlanContext): TeamPlan
planAgent(input: unknown, context: PlanContext): TeamPlan   // single agent, same semantics
PlanContext = {
  existingAgents: {id, name, manifestHash | null, revoked?, manifest?}[];
  existingConnections?: {fromAgentId, toAgentId}[];
  limits: {agentsPerWorkspace, connectionsPerWorkspace?};
  quotas?: {remaining?: {agents?, connections?, budgetUsd?}};
  registry?; loadAgent?;
}
```

Planning is pure and deterministic (same input and context → identical plan, in member and connection order). The plan lists each agent as `create`, `update` (with `previousHash` and depth-2 `changes` when the old manifest is supplied) or `noop`, each connection as `create` or `noop`, and reports:

- `errors` — `ok` is false if any exist and apply must refuse. Codes include the schema codes (`UNKNOWN_KEY`, `TOO_LARGE`, `URL_NOT_ALLOWED`, `DUPLICATE_NAME`, …), resolution codes (`TEMPLATE_NOT_FOUND`, `POLICY_LOOSENED`, …), `COORDINATOR_MISSING`, `UNKNOWN_MEMBER`, `SELF_CONNECTION`, `DUPLICATE_CONNECTION`, `CONNECTION_CYCLE` (with the cycle path), `DEPTH_EXCEEDED`, `CHILDREN_EXCEEDED`, `TEAM_BUDGET_EXCEEDED`, `CAPABILITY_UNSUPPORTED`, `NAME_CONFLICT` (a hand-made agent already uses the name) and `QUOTA_EXCEEDED` (workspace limits or remaining quota). Paths point into the submitted document, for example `spec.members[1].manifest.spec.policy.budgetUsd` or `spec.members[2].ref`.
- `warnings` — `UNREACHABLE_MEMBER`, `RUNTIME_PENDING`, `AMBIGUOUS_EXISTING`.
- `approvals` / `requiresApproval` — zero-cost is the default. Any created or updated agent with `budgetUsd > 0` (`BUDGET_NONZERO`) or a paid model provider `anthropic`, `openai` or `byo` (`PAID_MODEL`), and a non-zero team budget when anything changes, requires explicit owner approval before apply.
- `quota` and `summary` counts, and `team.teamHash` (hash over team metadata, coordinator, policy, connections and member hashes).

**Idempotency.** Apply records each agent's `manifestHash` under its manifest `name`. Planning the same team again then yields only no-ops and needs no approval. Revoked agents are ignored and can be re-created.

## Apply

`city_apply_team` (and manifest-mode `city_create_agent`, which applies a one-member plan without connections) runs in one transaction holding the workspace row lock:

1. **Idempotency receipt.** The `idempotency_key` is looked up per grant (per source bucket for anonymous calls). The same key with the same arguments returns the originally applied agents and connections, described from their current state; the same key with different arguments is a `conflict`. In unclaimed mode a replay never issues a claim token or enrollment codes again (`secrets_already_issued: true`), and keys must be unguessable (UUID v4 or 128-bit base64url). A new key simply re-plans, which yields no-ops for unchanged members.
2. **Re-plan under the lock** against the current workspace: manifest agents by name and hash, current connections, the workspace limits and the remaining capacity (`quotas.remaining`), forks preloaded from `agent_manifests` (own revisions, or other owners' `public` ones only).
3. **Autonomy checks** added to the plan's `errors`: `OWNER_APPROVAL_REQUIRED` (owned) or `UNCLAIMED_ZERO_COST_ONLY` (anonymous) for anything that would need spend approval, `RUNTIME_NOT_APPLICABLE` for `a2a` runtimes, `RUNTIME_MODE_CHANGE` when an update would switch hosted/external, `PARENT_NOT_FOUND` / `PARENT_NOT_ALLOWED` and `LINEAGE_TOO_DEEP` (lineage depth at most 4). A plan with connections to create warns `SCOPE_REQUIRED` without `connections:create`; apply then refuses with `forbidden`. Any error refuses the apply (`forbidden` for approval, `conflict` for pure quota, otherwise `invalid_arguments`) with the issues attached.
4. **`expected_team_hash`**, when given, must equal the re-planned `team_hash` (`TEAM_HASH_MISMATCH`, `conflict`), so an AI can review a plan and apply exactly that plan.
5. **Write.** Creates append agents with `manifestName`, `manifestHash`, `revision: 1`, `createdBy`, `parentAgentId`, `depth` and `rootSponsor`; updates bump `revision` and rewrite name, description and capability; each creation or update inserts the full resolved manifest into `agent_manifests(agent_id, revision, manifest_hash, manifest, created_at, operator_id)` (migration 5). Connections are created between the new ids. Workspace JSON stays bounded: it keeps only these small fields, never the manifest document.

**Lineage.** The coordinator is placed under `parent_agent_id` (or is a root with depth 0). Every member reachable from the coordinator gets the member that first connects to it (breadth-first, member order) as its parent; unreachable members share the coordinator's parent. `rootSponsor` is the owner (or `unclaimed:<source>` until claimed). Revoking an agent, by the owner or with `city_control`, revokes every descendant.

**Runtime.** `hosted` members become zero-cost deterministic demos; `external` members become runtime records and the response carries a single-use `enrollment_code` for each one that has no credential yet (see [REMOTE_MCP.md](REMOTE_MCP.md#runtime-enrollment)). The agent's native capability is its first manifest capability.

**Unclaimed mode.** Anonymous applies never match existing agents: each call creates new agents in the caller's source partition and returns a claim token; see [REMOTE_MCP.md](REMOTE_MCP.md#anonymous-mode-unclaimed-agents).

## Agent Cards and signing

```ts
compileAgentCard(resolved, { agentId, baseUrl, provider: {organization, url}, version?, documentationUrl?, iconUrl? }): AgentCard
signAgentCard(card, key, { jku?, now? }?): AgentCard
verifyAgentCard(card, jwks, { now? }?): { valid: boolean; results: VerifyResult[] }
generateSigningKey(kid?) / exportSigningKey / importSigningKey / publicJwk / exportJwks
```

The card follows the pinned A2A 1.0 `AgentCard` message (commit `1736957…`, see `docs/A2A_TRANSPORT.md`): `supportedInterfaces: [{url: "<baseUrl>/api/runtime/a2a/<agentId>", protocolBinding: "JSONRPC", protocolVersion: "1.0"}]` (the live message endpoint; `/a2a/<agentId>` is reserved as a future alias and today serves only `/a2a/<agentId>/.well-known/agent-card.json`), `capabilities {streaming: false, pushNotifications: false, extensions: [urn:central-city:a2a:native-auth:1, required]}`, `securitySchemes.centralCityNative.httpAuthSecurityScheme {scheme: "Bearer"}` with a matching `securityRequirements` entry, default modes `text/plain` in and `application/json` out, and skills from the manifest (or one per capability). `version` defaults to `m-<first 12 hex of manifestHash>`. `baseUrl` must be https, except http on loopback for development.

Signatures use JWS (RFC 7515) with Ed25519 (`alg: EdDSA`, RFC 8037) via `node:crypto`. The protected header is `{alg, kid, typ: "JOSE", iat, exp}` (plus optional `jku`): `iat` is the signing time and `exp` is `iat` plus 24 hours (`AGENT_CARD_SIGNATURE_TTL_SECONDS`), both in seconds. The payload is the JCS form of the card without `signatures` and is detached, so each entry is `{protected, signature}` and `detachedCompact()` gives `<protected>..<signature>`. The default `kid` is the RFC 7638 JWK thumbprint. Verification recomputes the canonical payload, rejects any `alg` other than EdDSA, `crit`/`b64` headers, and unknown `kid`s, and rejects a card signature without `iat` and `exp`, past its `exp` (`expired`), or with an `iat` more than 300 s in the future (`not-yet-valid`). It is valid when at least one signature verifies.

**Rotation.** The platform rotates by pre-publication, not dual signing: the next key's public JWK (`CITY_SIGNING_KEY_NEXT`) is published in the JWKS for at least the JWKS cache lifetime before it signs, then it becomes `CITY_SIGNING_KEY` and the retired key's public JWK moves to `CITY_SIGNING_KEY_PREVIOUS`, where it stays while cards and checkpoints it signed are still verified (see [REMOTE_MCP.md](REMOTE_MCP.md#agent-cards-and-signing)). `signAgentCard` can still append a second signature (it replaces only the same `kid`) for callers that dual-sign. Private keys serialize as Ed25519 JWKs and must be stored encrypted like other platform secrets; they must never be committed. Tests generate keys at run time.

**Serving.** Cards are compiled from the current manifest revision and signed per request with the platform key from `CITY_SIGNING_KEY`; the public keys are published at `/.well-known/jwks.json` (see [REMOTE_MCP.md](REMOTE_MCP.md#agent-cards-and-signing)).

## Open items

- An owner approval step for plans that need spend approval; until then AI clients may only apply zero-cost manifests.
- Outbound `a2a` runtimes and the `/a2a/<agentId>` message alias.
- Per-agent `maxChildren`/`maxDepth` are checked against team connections at plan time, and lineage depth is capped at apply; runtime delegation enforcement is future work.
- Manifest revisions are not part of the v1 offline backup format; a restored database keeps agents and their manifest hashes but serves no cards until manifests are re-applied.
