import { z } from 'zod';

/**
 * Declarative agent manifest `centralcity.agent/v1`. AI clients write these documents to describe
 * one agent (`kind: Agent`) or a whole team (`kind: Team`). This module is pure (no Node APIs) so
 * the browser console and the server share one validator. Resolution, planning, hashing and
 * Agent Card compilation live in `server/manifest/`.
 */
export const MANIFEST_API_VERSION = 'centralcity.agent/v1' as const;

export const MANIFEST_LIMITS = Object.freeze({
  /** UTF-8 bytes of the JSON document, checked before schema parsing. */
  manifestBytes: 32 * 1024,
  members: 20,
  connections: 100,
  skills: 32,
  capabilities: 8,
  mcpServers: 8,
  labels: 16,
  allowedDomains: 32,
  instructionsCharacters: 8000,
  maxDepth: 3,
  maxChildren: 20,
  budgetUsd: 1000,
});

/** Capabilities the platform can currently store and (for hosted agents) execute. */
export const KNOWN_CAPABILITIES = ['research', 'extract', 'verify'] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];
export const RUNTIME_MODES = ['hosted', 'external', 'a2a'] as const;
export const MODEL_PROVIDERS = ['platform', 'anthropic', 'openai', 'byo', 'external'] as const;
/** Providers whose use may incur charges; planning flags them as requiring approval. */
export const PAID_MODEL_PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openai', 'byo'];
export const APPROVAL_ACTIONS = [
  'spend',
  'paid-model',
  'external-network',
  'tool-call',
  'delegation',
  'publication',
] as const;
export const VISIBILITIES = ['private', 'org', 'public'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export type Visibility = (typeof VISIBILITIES)[number];

/** Machine-actionable validation problem. `path` is a dotted path into the submitted document. */
export interface ManifestIssue {
  code: string;
  path: string;
  message: string;
  hint: string;
}
export type ManifestParseResult<T> =
  { ok: true; value: T } | { ok: false; issues: ManifestIssue[] };

// ---------------------------------------------------------------------------------------------
// Host and URL checks. Static checks only: callers that fetch must still resolve DNS and refuse
// private addresses at connection time (DNS rebinding cannot be excluded statically).

const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
  'corp',
  'invalid',
  'test',
  'example',
  'onion',
  'nip.io',
  'sslip.io',
  'localtest.me',
];
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Returns a problem description for a hostname that is not a public DNS name, else null. */
export function hostProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return 'Host is empty.';
  if (host.startsWith('[') || host.includes(':'))
    return 'IP literal hosts are not allowed; use a public DNS name.';
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host))
    return 'IP literal hosts are not allowed; use a public DNS name.';
  if (host.length > 253) return 'Host name is too long.';
  const labels = host.split('.');
  if (labels.length < 2) return 'Single-label (intranet) hosts are not allowed.';
  if (!labels.every((label) => HOST_LABEL.test(label))) return 'Host name is not a valid DNS name.';
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return 'Host name is not a valid DNS name.';
  for (const suffix of BLOCKED_HOST_SUFFIXES)
    if (host === suffix || host.endsWith(`.${suffix}`))
      return `Private, loopback or reserved host suffix "${suffix}" is not allowed.`;
  return null;
}

/** Returns a problem for a URL that is not an https URL on a public DNS host, else null. */
export function publicHttpsUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'URL is not valid.';
  }
  if (url.protocol !== 'https:') return 'Only https URLs are allowed.';
  if (url.username || url.password) return 'URLs must not embed credentials.';
  if (url.hash) return 'URL fragments are not allowed.';
  return hostProblem(url.hostname);
}

// ---------------------------------------------------------------------------------------------
// Field schemas

const custom = (ctx: z.RefinementCtx, code: string, message: string, path: PropertyKey[] = []) =>
  ctx.addIssue({ code: 'custom', message, path, params: { code } });

const slug = (max = 63) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, digits and inner hyphens.');
// U+0000 is refused with a 400: Postgres jsonb cannot store it, so the save would fail with a 500.
const NO_NUL = /^[^\u0000]*$/;
const text = (max: number) =>
  z.string().trim().max(max).regex(NO_NUL, 'Remove control characters.');
const requiredText = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_NUL, 'Remove control characters.');
const mediaType = z
  .string()
  .max(100)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9*][a-z0-9!#$&^_.+*-]*$/i,
    'Use a media type such as text/plain.',
  );
const publicHttpsUrl = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    const problem = publicHttpsUrlProblem(value);
    if (problem) custom(ctx, 'URL_NOT_ALLOWED', problem);
  });
const domainPattern = z
  .string()
  .max(253)
  .superRefine((value, ctx) => {
    const host = value.startsWith('*.') ? value.slice(2) : value;
    if (value !== value.toLowerCase())
      return custom(ctx, 'DOMAIN_NOT_ALLOWED', 'Domains must be lowercase.');
    const problem = hostProblem(host);
    if (problem) custom(ctx, 'DOMAIN_NOT_ALLOWED', problem);
  });

function unique<T>(key: (item: T) => string, what: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const value = key(item);
      if (seen.has(value)) custom(ctx, 'DUPLICATE_NAME', `Duplicate ${what}.`, [index]);
      seen.add(value);
    });
  };
}
const uniqueStrings = (what: string) => unique<string>((value) => value, what);

const TEMPLATE_REF = /^template:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?@\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const AGENT_REF =
  /^agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[1-9]\d{0,8}$/;
/** `template:<id>@<semver>` or `agent:<uuid>@<revision>` (fork of an existing agent revision). */
export const extendsRefSchema = z
  .string()
  .max(128)
  .refine(
    (value) => TEMPLATE_REF.test(value) || AGENT_REF.test(value),
    'Use template:<id>@<major.minor.patch> or agent:<uuid>@<revision>.',
  );

export const capabilitySchema = slug(32);
const capabilitiesSchema = z
  .array(capabilitySchema)
  .min(1)
  .max(MANIFEST_LIMITS.capabilities)
  .superRefine(uniqueStrings('capability'));
const modelSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:/@-]+$/)
      .optional(),
  })
  .strict();
const runtimeFields = {
  model: modelSchema.optional(),
  endpoint: publicHttpsUrl.optional(),
};
const runtimeInputSchema = z
  .object({ mode: z.enum(RUNTIME_MODES).optional(), ...runtimeFields })
  .strict();
const runtimeSchema = z
  .object({ mode: z.enum(RUNTIME_MODES), ...runtimeFields })
  .strict()
  .superRefine((runtime, ctx) => {
    if (runtime.mode === 'a2a' && !runtime.endpoint)
      custom(ctx, 'ENDPOINT_REQUIRED', 'An a2a runtime requires an https endpoint.', ['endpoint']);
    if (runtime.mode !== 'a2a' && runtime.endpoint)
      custom(ctx, 'ENDPOINT_NOT_ALLOWED', 'Only a2a runtimes declare an endpoint.', ['endpoint']);
    if (runtime.mode === 'hosted' && runtime.model?.provider === 'external')
      custom(ctx, 'MODEL_PROVIDER_INVALID', 'Hosted agents cannot use an external model.', [
        'model',
        'provider',
      ]);
    if (runtime.mode !== 'hosted' && runtime.model?.provider === 'platform')
      custom(
        ctx,
        'MODEL_PROVIDER_INVALID',
        'The platform model is only available to hosted agents.',
        ['model', 'provider'],
      );
  });
const skillSchema = z
  .object({
    id: slug(64),
    name: requiredText(64),
    description: requiredText(500),
    tags: z.array(requiredText(32)).max(16).default([]),
    inputModes: z.array(mediaType).max(8).optional(),
    outputModes: z.array(mediaType).max(8).optional(),
    examples: z.array(requiredText(500)).max(8).optional(),
  })
  .strict();
const skillsSchema = z
  .array(skillSchema)
  .max(MANIFEST_LIMITS.skills)
  .superRefine(unique((skill) => skill.id, 'skill id'));
const mcpServerSchema = z
  .object({
    name: slug(63),
    url: publicHttpsUrl,
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9._:/-]+$/),
      )
      .max(16)
      .default([]),
  })
  .strict();
const mcpServersSchema = z
  .array(mcpServerSchema)
  .max(MANIFEST_LIMITS.mcpServers)
  .superRefine(unique((server) => server.name, 'MCP server name'));
const budgetSchema = z
  .number()
  .min(0)
  .max(MANIFEST_LIMITS.budgetUsd)
  .refine(
    (value) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    'Budgets use at most two decimal places.',
  );
const policyFields = {
  budgetUsd: budgetSchema,
  maxChildren: z.number().int().min(0).max(MANIFEST_LIMITS.maxChildren),
  maxDepth: z.number().int().min(0).max(MANIFEST_LIMITS.maxDepth),
  allowedDomains: z
    .array(domainPattern)
    .max(MANIFEST_LIMITS.allowedDomains)
    .superRefine(uniqueStrings('domain')),
  approvalRequiredFor: z
    .array(z.enum(APPROVAL_ACTIONS))
    .max(APPROVAL_ACTIONS.length)
    .superRefine(uniqueStrings('approval action')),
};
export const DEFAULT_AGENT_POLICY = Object.freeze({
  budgetUsd: 0,
  maxChildren: 0,
  maxDepth: 3,
  allowedDomains: [] as string[],
  approvalRequiredFor: [] as Array<(typeof APPROVAL_ACTIONS)[number]>,
});
const policyInputSchema = z
  .object({
    budgetUsd: policyFields.budgetUsd.optional(),
    maxChildren: policyFields.maxChildren.optional(),
    maxDepth: policyFields.maxDepth.optional(),
    allowedDomains: policyFields.allowedDomains.optional(),
    approvalRequiredFor: policyFields.approvalRequiredFor.optional(),
  })
  .strict();
const policySchema = z
  .object({
    budgetUsd: policyFields.budgetUsd.default(DEFAULT_AGENT_POLICY.budgetUsd),
    maxChildren: policyFields.maxChildren.default(DEFAULT_AGENT_POLICY.maxChildren),
    maxDepth: policyFields.maxDepth.default(DEFAULT_AGENT_POLICY.maxDepth),
    allowedDomains: policyFields.allowedDomains.default([]),
    approvalRequiredFor: policyFields.approvalRequiredFor.default([]),
  })
  .strict();
const labelsSchema = z
  .record(
    slug(63),
    z
      .string()
      .max(63)
      .regex(/^[A-Za-z0-9._-]*$/),
  )
  .refine(
    (labels) => Object.keys(labels).length <= MANIFEST_LIMITS.labels,
    `At most ${MANIFEST_LIMITS.labels} labels.`,
  );
const metadataInputSchema = z
  .object({
    name: slug(63),
    displayName: requiredText(64).optional(),
    description: text(300).optional(),
    labels: labelsSchema.optional(),
  })
  .strict();
const metadataSchema = z
  .object({
    name: slug(63),
    displayName: requiredText(64),
    description: text(300).default(''),
    labels: labelsSchema.default({}),
  })
  .strict();

/** Agent spec as written. Every field is optional so `extends` can supply the rest. */
const agentSpecInputSchema = z
  .object({
    extends: extendsRefSchema.optional(),
    capabilities: capabilitiesSchema.optional(),
    runtime: runtimeInputSchema.optional(),
    instructions: text(MANIFEST_LIMITS.instructionsCharacters).optional(),
    skills: skillsSchema.optional(),
    tools: z.object({ mcpServers: mcpServersSchema.optional() }).strict().optional(),
    policy: policyInputSchema.optional(),
    visibility: z.enum(VISIBILITIES).optional(),
  })
  .strict();
/** Fully-resolved agent spec: required fields present and defaults applied. */
const agentSpecSchema = z
  .object({
    extends: extendsRefSchema.optional(),
    capabilities: capabilitiesSchema,
    runtime: runtimeSchema,
    instructions: text(MANIFEST_LIMITS.instructionsCharacters).default(''),
    skills: skillsSchema.default([]),
    tools: z
      .object({ mcpServers: mcpServersSchema.default([]) })
      .strict()
      .prefault({}),
    policy: policySchema.prefault({}),
    visibility: z.enum(VISIBILITIES).default('private'),
  })
  .strict();

export const agentManifestSchema = z
  .object({
    apiVersion: z.literal(MANIFEST_API_VERSION),
    kind: z.literal('Agent'),
    metadata: metadataInputSchema,
    spec: agentSpecInputSchema,
  })
  .strict();
export const resolvedAgentManifestSchema = z
  .object({
    apiVersion: z.literal(MANIFEST_API_VERSION),
    kind: z.literal('Agent'),
    metadata: metadataSchema,
    spec: agentSpecSchema,
  })
  .strict();

const teamMemberSchema = z
  .object({
    name: slug(63),
    manifest: agentManifestSchema.optional(),
    ref: extendsRefSchema.optional(),
  })
  .strict()
  .superRefine((member, ctx) => {
    if (Boolean(member.manifest) === Boolean(member.ref))
      custom(ctx, 'MEMBER_SOURCE', 'A member declares exactly one of manifest or ref.');
    if (member.manifest && member.manifest.metadata.name !== member.name)
      custom(
        ctx,
        'NAME_MISMATCH',
        `Inline manifest name must equal the member name "${member.name}".`,
        ['manifest', 'metadata', 'name'],
      );
  });
export const teamManifestSchema = z
  .object({
    apiVersion: z.literal(MANIFEST_API_VERSION),
    kind: z.literal('Team'),
    metadata: metadataInputSchema,
    spec: z
      .object({
        coordinator: slug(63),
        members: z
          .array(teamMemberSchema)
          .min(1)
          .max(MANIFEST_LIMITS.members)
          .superRefine(unique((member) => member.name, 'member name')),
        connections: z
          .array(z.object({ from: slug(63), to: slug(63) }).strict())
          .max(MANIFEST_LIMITS.connections)
          .default([]),
        policy: z
          .object({
            budgetUsd: budgetSchema.default(0),
            maxDepth: policyFields.maxDepth.default(MANIFEST_LIMITS.maxDepth),
          })
          .strict()
          .prefault({}),
      })
      .strict(),
  })
  .strict();

export type AgentManifestInput = z.input<typeof agentManifestSchema>;
export type AgentManifest = z.output<typeof agentManifestSchema>;
export type ResolvedAgentManifest = z.output<typeof resolvedAgentManifestSchema>;
export type TeamManifestInput = z.input<typeof teamManifestSchema>;
export type TeamManifest = z.output<typeof teamManifestSchema>;
export type AgentSkillSpec = z.output<typeof skillSchema>;
export type AgentPolicy = ResolvedAgentManifest['spec']['policy'];

// ---------------------------------------------------------------------------------------------
// Parsing helpers with machine-actionable issues

const HINTS: Record<string, string> = {
  UNKNOWN_KEY: 'Remove the unrecognized field; manifests reject unknown keys.',
  TOO_LARGE: 'Shorten the value or reduce the number of entries.',
  TOO_SMALL: 'Provide a longer value or more entries.',
  INVALID_TYPE: 'Use the documented type for this field.',
  INVALID_VALUE: 'Use one of the documented values.',
  URL_NOT_ALLOWED: 'Use an https URL on a public DNS host (no IPs, localhost or private suffixes).',
  DOMAIN_NOT_ALLOWED: 'Use a lowercase public DNS name, optionally prefixed with "*.".',
  DUPLICATE_NAME: 'Names and ids must be unique within their list.',
  MANIFEST_TOO_LARGE: `Keep the JSON document at or below ${MANIFEST_LIMITS.manifestBytes} bytes.`,
  MANIFEST_NOT_JSON: 'Submit a plain JSON object.',
  ENDPOINT_REQUIRED: 'Set spec.runtime.endpoint to the https A2A endpoint.',
  ENDPOINT_NOT_ALLOWED: 'Remove spec.runtime.endpoint or set spec.runtime.mode to "a2a".',
  MODEL_PROVIDER_INVALID: 'Choose a model provider compatible with spec.runtime.mode.',
  MEMBER_SOURCE: 'Give the member either an inline manifest or a ref, not both.',
  NAME_MISMATCH: 'Make metadata.name of the inline manifest equal the member name.',
  KIND_UNSUPPORTED: 'Use kind "Agent" or "Team".',
};
export const issueHint = (code: string) => HINTS[code] ?? 'Correct the value and plan again.';

export function manifestIssue(
  code: string,
  path: PropertyKey[] | string,
  message: string,
  hint = issueHint(code),
): ManifestIssue {
  return {
    code,
    path: typeof path === 'string' ? path : formatPath(path),
    message,
    hint,
  };
}
/**
 * Dotted path into the submitted document. Received values are never echoed: a key segment keeps
 * only [A-Za-z0-9_-] (anything else becomes `?`, so a key cannot carry text or pose as nesting),
 * and the path is capped, the same rule as server/validation-errors.ts.
 */
export function formatPath(path: readonly PropertyKey[]): string {
  const segment = (part: PropertyKey) =>
    typeof part === 'symbol' ? '?' : String(part).replace(/[^A-Za-z0-9_-]/g, '?');
  return path
    .reduce<string>(
      (out, part) =>
        typeof part === 'number'
          ? `${out}[${part}]`
          : out
            ? `${out}.${segment(part)}`
            : segment(part),
      '',
    )
    .slice(0, 100);
}

export function zodIssues(error: z.ZodError, prefix: PropertyKey[] = []): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  for (const issue of error.issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys)
        issues.push(manifestIssue('UNKNOWN_KEY', [...path, key], 'Unknown key.'));
      continue;
    }
    const code =
      issue.code === 'custom'
        ? String((issue.params as { code?: string } | undefined)?.code ?? 'INVALID_VALUE')
        : issue.code === 'too_big'
          ? 'TOO_LARGE'
          : issue.code === 'too_small'
            ? 'TOO_SMALL'
            : issue.code === 'invalid_type'
              ? 'INVALID_TYPE'
              : 'INVALID_VALUE';
    issues.push(manifestIssue(code, path, issue.message));
  }
  return issues;
}

/** UTF-8 byte size of a JSON value, or null when it is not JSON-serializable. */
export function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).length;
  } catch {
    return null;
  }
}

function sizeIssue(input: unknown): ManifestIssue | null {
  const bytes = jsonByteLength(input);
  if (bytes === null)
    return manifestIssue('MANIFEST_NOT_JSON', '', 'Manifest is not JSON-serializable.');
  if (bytes > MANIFEST_LIMITS.manifestBytes)
    return manifestIssue(
      'MANIFEST_TOO_LARGE',
      '',
      `Manifest is ${bytes} bytes; the limit is ${MANIFEST_LIMITS.manifestBytes}.`,
    );
  return null;
}

function parseWith<S extends z.ZodType>(
  schema: S,
  input: unknown,
): ManifestParseResult<z.output<S>> {
  const tooLarge = sizeIssue(input);
  if (tooLarge) return { ok: false, issues: [tooLarge] };
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: zodIssues(parsed.error) };
}

export const parseAgentManifest = (input: unknown) => parseWith(agentManifestSchema, input);
export const parseTeamManifest = (input: unknown) => parseWith(teamManifestSchema, input);

export function parseManifest(
  input: unknown,
):
  | { ok: true; kind: 'Agent'; value: AgentManifest }
  | { ok: true; kind: 'Team'; value: TeamManifest }
  | { ok: false; issues: ManifestIssue[] } {
  const kind = (input as { kind?: unknown } | null)?.kind;
  if (kind === 'Agent') {
    const result = parseAgentManifest(input);
    return result.ok ? { ok: true, kind, value: result.value } : result;
  }
  if (kind === 'Team') {
    const result = parseTeamManifest(input);
    return result.ok ? { ok: true, kind, value: result.value } : result;
  }
  return {
    ok: false,
    issues: [manifestIssue('KIND_UNSUPPORTED', 'kind', 'Manifest kind must be Agent or Team.')],
  };
}
