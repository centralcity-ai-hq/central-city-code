import {
  MANIFEST_API_VERSION,
  agentManifestSchema,
  teamManifestSchema,
  type AgentManifest,
  type AgentManifestInput,
  type TeamManifest,
  type TeamManifestInput,
} from '../../shared/manifest.js';

/**
 * Versioned built-in manifest templates. A template version is immutable: changing content means
 * publishing a new version, so `template:<id>@<version>` always resolves to the same document and
 * resolved manifest hashes stay stable. The listing `title` and `description` (outside `manifest`)
 * are catalog copy: never resolved or hashed, so they may be reworded within a version.
 */
export interface AgentTemplate {
  kind: 'Agent';
  id: string;
  version: string;
  title: string;
  description: string;
  /** Flat agent manifest (no `extends`). */
  manifest: AgentManifest;
}
export interface TeamTemplate {
  kind: 'Team';
  id: string;
  version: string;
  title: string;
  description: string;
  manifest: TeamManifest;
}
export type ManifestTemplate = AgentTemplate | TeamTemplate;
export interface TemplateRegistry {
  get(id: string, version: string): ManifestTemplate | undefined;
  /** All templates sorted by id, then version. */
  list(): ManifestTemplate[];
}

export const templateRef = (template: Pick<ManifestTemplate, 'id' | 'version'>) =>
  `template:${template.id}@${template.version}`;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type TemplateSource =
  | (Omit<AgentTemplate, 'manifest'> & { manifest: AgentManifestInput })
  | (Omit<TeamTemplate, 'manifest'> & { manifest: TeamManifestInput });

/** Validates each template and rejects duplicates, extending templates and name/id mismatch. */
export function createTemplateRegistry(sources: readonly TemplateSource[]): TemplateRegistry {
  const byRef = new Map<string, ManifestTemplate>();
  for (const source of sources) {
    const ref = templateRef(source);
    if (
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(source.id) ||
      !/^\d+\.\d+\.\d+$/.test(source.version)
    )
      throw new Error(`Invalid template reference ${ref}.`);
    if (byRef.has(ref)) throw new Error(`Duplicate template ${ref}.`);
    let template: ManifestTemplate;
    if (source.kind === 'Agent') {
      const manifest = agentManifestSchema.parse(source.manifest);
      if (manifest.spec.extends) throw new Error(`Template ${ref} must not extend another.`);
      if (manifest.metadata.name !== source.id)
        throw new Error(`Template ${ref} metadata.name must equal its id.`);
      template = { ...source, manifest };
    } else {
      template = { ...source, manifest: teamManifestSchema.parse(source.manifest) };
    }
    byRef.set(ref, deepFreeze(template));
  }
  const sorted = [...byRef.values()].sort((a, b) =>
    a.id === b.id ? compareVersions(a.version, b.version) : a.id < b.id ? -1 : 1,
  );
  return {
    get: (id, version) => byRef.get(`template:${id}@${version}`),
    list: () => [...sorted],
  };
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

const demoRuntime = { mode: 'hosted', model: { provider: 'platform', name: 'deterministic-demo' } };
const text = { inputModes: ['text/plain'], outputModes: ['application/json'] };

export const BUILTIN_TEMPLATE_SOURCES: readonly TemplateSource[] = [
  {
    kind: 'Agent',
    id: 'research-analyst',
    version: '1.0.0',
    title: 'Research analyst',
    description:
      'Organizes supplied text into a short brief with source URLs. Zero-cost, deterministic built-in agent that runs on Central City.',
    manifest: {
      apiVersion: MANIFEST_API_VERSION,
      kind: 'Agent',
      metadata: {
        name: 'research-analyst',
        displayName: 'Research analyst',
        description:
          'Organizes supplied text into a bounded brief. It does not browse or generate new factual claims.',
        labels: { template: 'research-analyst' },
      },
      spec: {
        capabilities: ['research'],
        runtime: demoRuntime,
        instructions:
          'Summarize the supplied text into at most five lines and list every source URL it contains.',
        skills: [
          {
            id: 'research-brief',
            name: 'Research brief',
            description:
              'Turns supplied text into a short brief and lists its source URLs for independent checking.',
            tags: ['research', 'brief', 'cc-agent'],
            ...text,
            examples: ['Summarize these notes and list their sources.'],
          },
        ],
        policy: { budgetUsd: 0, maxChildren: 0, maxDepth: 1 },
        visibility: 'private',
      },
    } as AgentManifestInput,
  },
  {
    kind: 'Agent',
    id: 'extractor',
    version: '1.0.0',
    title: 'Extractor',
    description:
      'Extracts key/value fields, URLs and numbers from supplied text. Zero-cost, deterministic built-in agent that runs on Central City.',
    manifest: {
      apiVersion: MANIFEST_API_VERSION,
      kind: 'Agent',
      metadata: {
        name: 'extractor',
        displayName: 'Extractor',
        description: 'Pattern extraction from supplied text only. No external sources are fetched.',
        labels: { template: 'extractor' },
      },
      spec: {
        capabilities: ['extract'],
        runtime: demoRuntime,
        instructions: 'Extract "key: value" fields, URLs and numbers from the supplied text.',
        skills: [
          {
            id: 'field-extraction',
            name: 'Field extraction',
            description: 'Returns key/value fields, URLs and numbers found in the supplied text.',
            tags: ['extract', 'fields', 'cc-agent'],
            ...text,
            examples: ['Invoice amount: 42'],
          },
        ],
        policy: { budgetUsd: 0, maxChildren: 0, maxDepth: 1 },
        visibility: 'private',
      },
    } as AgentManifestInput,
  },
  {
    kind: 'Agent',
    id: 'fact-checker',
    version: '1.0.0',
    title: 'Fact checker (structural)',
    description:
      'Runs structural checks on supplied text. Does not verify factual accuracy. Zero-cost, deterministic built-in agent that runs on Central City.',
    manifest: {
      apiVersion: MANIFEST_API_VERSION,
      kind: 'Agent',
      metadata: {
        name: 'fact-checker',
        displayName: 'Fact checker',
        description:
          'Structural checks only (non-empty, source URL present, JSON syntax). Factual accuracy is not verified.',
        labels: { template: 'fact-checker' },
      },
      spec: {
        capabilities: ['verify'],
        runtime: demoRuntime,
        instructions:
          'Check that the supplied text is non-empty, cites a source URL and, if JSON, parses.',
        skills: [
          {
            id: 'structural-check',
            name: 'Structural check',
            description:
              'Reports whether supplied text is non-empty, cites a source URL and is valid JSON.',
            tags: ['verify', 'checks', 'cc-agent'],
            ...text,
            examples: ['Check this brief before I rely on it.'],
          },
        ],
        policy: { budgetUsd: 0, maxChildren: 0, maxDepth: 1 },
        visibility: 'private',
      },
    } as AgentManifestInput,
  },
  {
    kind: 'Team',
    id: 'research-team',
    version: '1.0.0',
    title: 'Research team',
    description:
      'An external requester delegates to a hosted research analyst, which hands its brief to a structural checker.',
    manifest: {
      apiVersion: MANIFEST_API_VERSION,
      kind: 'Team',
      metadata: {
        name: 'research-team',
        displayName: 'Research team',
        // Hashed into this version's team_hash: reword only in a new template version.
        description: 'Requester → researcher → checker. Zero-cost hosted CC agents.',
      },
      spec: {
        coordinator: 'requester',
        members: [
          {
            name: 'requester',
            manifest: {
              apiVersion: MANIFEST_API_VERSION,
              kind: 'Agent',
              metadata: {
                name: 'requester',
                displayName: 'Requester',
                description: 'Your own runtime that submits work to the team.',
              },
              spec: {
                capabilities: ['research'],
                runtime: { mode: 'external' },
                policy: { maxChildren: 1, maxDepth: 2 },
              },
            },
          },
          {
            name: 'researcher',
            manifest: {
              apiVersion: MANIFEST_API_VERSION,
              kind: 'Agent',
              metadata: { name: 'researcher', displayName: 'Researcher' },
              spec: { extends: 'template:research-analyst@1.0.0', policy: { maxChildren: 1 } },
            },
          },
          { name: 'checker', ref: 'template:fact-checker@1.0.0' },
        ],
        connections: [
          { from: 'requester', to: 'researcher' },
          { from: 'researcher', to: 'checker' },
        ],
        policy: { budgetUsd: 0, maxDepth: 2 },
      },
    } as TeamManifestInput,
  },
];

export const builtinTemplates: TemplateRegistry = createTemplateRegistry(BUILTIN_TEMPLATE_SOURCES);
