import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_API_VERSION,
  MANIFEST_LIMITS,
  ManifestError,
  builtinTemplates,
  canonicalHash,
  canonicalize,
  compileAgentCard,
  createTemplateRegistry,
  exportJwks,
  exportSigningKey,
  generateSigningKey,
  hostProblem,
  importSigningKey,
  parseAgentManifest,
  parseManifest,
  parseTeamManifest,
  planAgent,
  planTeam,
  publicHttpsUrlProblem,
  resolveManifest,
  signAgentCard,
  templateRef,
  verifyAgentCard,
  type AgentCard,
  type AgentLoader,
  type ExistingManifestAgent,
  type PlanContext,
  type ResolvedAgentManifest,
  type TeamPlan,
} from '../server/manifest/index.js';

const agent = (spec: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
  apiVersion: MANIFEST_API_VERSION,
  kind: 'Agent',
  metadata: { name: 'helper', ...metadata },
  spec,
});
const hosted = { capabilities: ['extract'], runtime: { mode: 'hosted' } };
const codes = (result: { ok: boolean; issues?: Array<{ code: string }> }) =>
  result.ok ? [] : result.issues!.map((issue) => issue.code);
const rejects = (input: unknown, code: string, path?: string) => {
  const result = parseAgentManifest(input);
  assert.equal(result.ok, false, `expected ${code}`);
  if (!result.ok) {
    const issue = result.issues.find((candidate) => candidate.code === code);
    assert.ok(issue, `expected ${code}, got ${JSON.stringify(result.issues)}`);
    if (path !== undefined) assert.equal(issue.path, path);
    assert.ok(issue.hint.length > 0);
  }
};
const context = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  existingAgents: [],
  existingConnections: [],
  limits: { agentsPerWorkspace: 100, connectionsPerWorkspace: 500 },
  ...overrides,
});
const researchTeam = () => {
  const template = builtinTemplates.get('research-team', '1.0.0');
  assert.ok(template && template.kind === 'Team');
  return structuredClone(template.manifest) as unknown as {
    spec: {
      members: Array<Record<string, unknown>>;
      connections: Array<{ from: string; to: string }>;
      policy: { budgetUsd: number; maxDepth: number };
      coordinator: string;
    };
  } & Record<string, unknown>;
};
/** Simulates applying a plan: every planned agent now exists with its hash. */
function applied(plan: TeamPlan) {
  const existingAgents: ExistingManifestAgent[] = plan.agents.map((planned, index) => ({
    id: planned.agentId ?? `00000000-0000-4000-8000-00000000000${index}`,
    name: planned.name,
    manifestHash: planned.manifestHash,
    manifest: planned.manifest,
  }));
  const id = (name: string) => existingAgents.find((a) => a.name === name)!.id;
  return context({
    existingAgents,
    existingConnections: plan.connections.map((edge) => ({
      fromAgentId: id(edge.from),
      toAgentId: id(edge.to),
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// Canonicalization

test('JCS canonicalization matches RFC 8785 examples and rejects non-I-JSON values', () => {
  const sample = JSON.parse(
    '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
  );
  assert.equal(
    canonicalize(sample),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
  const keys = JSON.parse(
    '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
  );
  // RFC 8785 section 3.2.3 order: "\r", "1", "\u0080", "ö", "€", "😀", "דּ".
  assert.ok(canonicalize(keys).startsWith('{"\\r":"Carriage Return","1":"One","\u0080":"Control"'));
  assert.ok(
    canonicalize(keys).endsWith(
      '"😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    ),
  );
  assert.equal(
    canonicalize({ b: 1, a: [true, -0, 1e21, 1e-7], c: undefined }),
    '{"a":[true,0,1e+21,1e-7],"b":1}',
  );
  for (const bad of [NaN, Infinity, [undefined], new Date(0), '\ud800', { ['\udc00']: 1 }, 1n])
    assert.throws(() => canonicalize(bad));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalize(cyclic));
  assert.equal(
    canonicalHash({ a: 1, b: { d: 2, c: 3 } }),
    canonicalHash({ b: { c: 3, d: 2 }, a: 1 }),
  );
});

// ---------------------------------------------------------------------------------------------
// Schema accept/reject matrix

test('schema accepts a complete agent manifest and applies no hidden defaults on input', () => {
  const result = parseAgentManifest(
    agent(
      {
        capabilities: ['research', 'custom-cap'],
        runtime: {
          mode: 'a2a',
          model: { provider: 'external', name: 'my-model' },
          endpoint: 'https://agents.example.com/a2a',
        },
        instructions: 'Be brief.',
        skills: [
          {
            id: 's1',
            name: 'Skill',
            description: 'Does things.',
            tags: ['a'],
            inputModes: ['text/plain'],
            outputModes: ['application/json'],
            examples: ['x'],
          },
        ],
        tools: {
          mcpServers: [{ name: 'docs', url: 'https://mcp.example.com/mcp', scopes: ['read'] }],
        },
        policy: {
          budgetUsd: 1.25,
          maxChildren: 2,
          maxDepth: 3,
          allowedDomains: ['*.example.org', 'api.example.com'],
          approvalRequiredFor: ['spend', 'tool-call'],
        },
        visibility: 'org',
      },
      { displayName: 'Helper', description: 'Helps.', labels: { team: 'blue' } },
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(!result.ok && result.issues));
});

test('schema rejects unknown keys, wrong versions and invalid values with paths and hints', () => {
  rejects({ ...agent(hosted), extra: 1 }, 'UNKNOWN_KEY', 'extra');
  rejects(agent({ ...hosted, secret: 'x' }), 'UNKNOWN_KEY', 'spec.secret');
  rejects(
    agent({ ...hosted, runtime: { mode: 'hosted', gpu: true } }),
    'UNKNOWN_KEY',
    'spec.runtime.gpu',
  );
  rejects({ ...agent(hosted), apiVersion: 'centralcity.agent/v2' }, 'INVALID_VALUE', 'apiVersion');
  rejects(agent(hosted, { name: 'Not A Slug' }), 'INVALID_VALUE', 'metadata.name');
  rejects(
    agent({ ...hosted, runtime: { mode: 'serverless' } }),
    'INVALID_VALUE',
    'spec.runtime.mode',
  );
  rejects(agent({ ...hosted, policy: { budgetUsd: -1 } }), 'TOO_SMALL', 'spec.policy.budgetUsd');
  rejects(agent({ ...hosted, policy: { budgetUsd: 0.001 } }), 'INVALID_VALUE');
  rejects(agent({ ...hosted, policy: { maxDepth: 4 } }), 'TOO_LARGE', 'spec.policy.maxDepth');
  rejects(agent({ ...hosted, policy: { approvalRequiredFor: ['anything'] } }), 'INVALID_VALUE');
  rejects(
    agent({ ...hosted, capabilities: ['extract', 'extract'] }),
    'DUPLICATE_NAME',
    'spec.capabilities[1]',
  );
  rejects(agent({ ...hosted, extends: 'template:x' }), 'INVALID_VALUE', 'spec.extends');
  rejects(agent({ ...hosted, extends: 'agent:not-a-uuid@1' }), 'INVALID_VALUE', 'spec.extends');
  rejects(
    agent({ ...hosted, instructions: 'x'.repeat(MANIFEST_LIMITS.instructionsCharacters + 1) }),
    'TOO_LARGE',
  );
  // U+0000 cannot be stored in jsonb: refused here with a hint, never a failed save.
  rejects(agent({ ...hosted, instructions: 'a\u0000b' }), 'INVALID_VALUE', 'spec.instructions');
  assert.deepEqual(codes(parseManifest({ kind: 'Robot' })), ['KIND_UNSUPPORTED']);
});

test('schema enforces runtime cross-field rules', () => {
  // Input documents may be partial (extends can supply fields); cross-field rules run on resolve.
  assert.equal(
    parseAgentManifest(agent({ capabilities: ['research'], runtime: { mode: 'a2a' } })).ok,
    true,
  );
  // Cross-field rules apply to resolved manifests; a direct resolve reports them.
  assert.throws(
    () => resolveManifest(agent({ capabilities: ['research'], runtime: { mode: 'a2a' } })),
    (error: unknown) =>
      error instanceof ManifestError && error.issues[0]!.code === 'ENDPOINT_REQUIRED',
  );
  for (const [runtime, code] of [
    [{ mode: 'hosted', endpoint: 'https://agents.example.org/a2a' }, 'ENDPOINT_NOT_ALLOWED'],
    [{ mode: 'hosted', model: { provider: 'external' } }, 'MODEL_PROVIDER_INVALID'],
    [{ mode: 'external', model: { provider: 'platform' } }, 'MODEL_PROVIDER_INVALID'],
  ] as const)
    assert.throws(
      () => resolveManifest(agent({ capabilities: ['research'], runtime })),
      (error: unknown) =>
        error instanceof ManifestError && error.issues.some((i) => i.code === code),
    );
});

test('schema enforces size limits on documents, skills and team members', () => {
  const huge = agent({ ...hosted, instructions: 'x'.repeat(10) }, { description: 'y'.repeat(100) });
  (huge.spec as Record<string, unknown>).padding = 'z'.repeat(MANIFEST_LIMITS.manifestBytes);
  assert.deepEqual(codes(parseAgentManifest(huge)), ['MANIFEST_TOO_LARGE']);
  const skill = (id: number) => ({ id: `s${id}`, name: 'n', description: 'd' });
  rejects(
    agent({ ...hosted, skills: Array.from({ length: 33 }, (_, i) => skill(i)) }),
    'TOO_LARGE',
    'spec.skills',
  );
  assert.equal(
    parseAgentManifest(agent({ ...hosted, skills: Array.from({ length: 32 }, (_, i) => skill(i)) }))
      .ok,
    true,
  );
  rejects(agent({ ...hosted, skills: [skill(1), skill(1)] }), 'DUPLICATE_NAME', 'spec.skills[1]');
  const team = researchTeam();
  team.spec.members = Array.from({ length: 21 }, (_, i) => ({
    name: `m${i}`,
    ref: 'template:extractor@1.0.0',
  }));
  assert.ok(codes(parseTeamManifest(team)).includes('TOO_LARGE'));
  const dup = researchTeam();
  dup.spec.members.push({ name: 'checker', ref: 'template:extractor@1.0.0' });
  assert.ok(codes(parseTeamManifest(dup)).includes('DUPLICATE_NAME'));
  const both = researchTeam();
  both.spec.members[2] = {
    name: 'checker',
    ref: 'template:fact-checker@1.0.0',
    manifest: agent(hosted, { name: 'checker' }),
  };
  assert.ok(codes(parseTeamManifest(both)).includes('MEMBER_SOURCE'));
  const mismatch = researchTeam();
  mismatch.spec.members[2] = { name: 'checker', manifest: agent(hosted, { name: 'other' }) };
  assert.ok(codes(parseTeamManifest(mismatch)).includes('NAME_MISMATCH'));
  assert.deepEqual(codes(parseAgentManifest({ a: 1n })), ['MANIFEST_NOT_JSON']);
});

test('URLs must be https on public DNS hosts (SSRF-style hosts rejected)', () => {
  for (const url of [
    'http://agents.example.org/a2a',
    'https://localhost/a2a',
    'https://api.localhost/a2a',
    'https://127.0.0.1/a2a',
    'https://2130706433/a2a',
    'https://0x7f.1/a2a',
    'https://10.0.0.8/a2a',
    'https://169.254.169.254/latest',
    'https://[::1]/a2a',
    'https://[fd00::1]/a2a',
    'https://metadata.google.internal/',
    'https://printer.local/',
    'https://router.home.arpa/',
    'https://intranet/',
    'https://127.0.0.1.nip.io/',
    'https://user:pass@agents.example.org/',
    'https://agents.example.org/#frag',
    'ftp://agents.example.org/',
    'not a url',
  ])
    assert.ok(publicHttpsUrlProblem(url), `${url} should be rejected`);
  for (const url of [
    'https://agents.example.org/a2a',
    'https://mcp.vendor.co.uk:8443/mcp',
    'https://xn--bcher-kva.example.net/',
  ])
    assert.equal(publicHttpsUrlProblem(url), null, url);
  assert.ok(hostProblem('localtest.me'));
  rejects(
    agent({ ...hosted, tools: { mcpServers: [{ name: 'x', url: 'https://10.1.2.3/mcp' }] } }),
    'URL_NOT_ALLOWED',
    'spec.tools.mcpServers[0].url',
  );
  rejects(
    agent({
      capabilities: ['research'],
      runtime: { mode: 'a2a', endpoint: 'https://localhost:8443/' },
    }),
    'URL_NOT_ALLOWED',
    'spec.runtime.endpoint',
  );
  rejects(
    agent({ ...hosted, policy: { allowedDomains: ['169.254.169.254'] } }),
    'DOMAIN_NOT_ALLOWED',
  );
  rejects(agent({ ...hosted, policy: { allowedDomains: ['Example.org'] } }), 'DOMAIN_NOT_ALLOWED');
});

// ---------------------------------------------------------------------------------------------
// Templates and resolution

test('built-in template library lists versioned zero-cost templates', () => {
  const refs = builtinTemplates.list().map(templateRef);
  assert.deepEqual(refs, [
    'template:extractor@1.0.0',
    'template:fact-checker@1.0.0',
    'template:research-analyst@1.0.0',
    'template:research-team@1.0.0',
  ]);
  for (const template of builtinTemplates.list()) {
    if (template.kind !== 'Agent') continue;
    const { manifest } = resolveManifest(agent({ extends: templateRef(template) }, { name: 'x' }));
    assert.equal(manifest.spec.runtime.mode, 'hosted');
    assert.equal(manifest.spec.runtime.model?.provider, 'platform');
    assert.equal(manifest.spec.policy.budgetUsd, 0);
  }
  assert.equal(builtinTemplates.get('research-analyst', '9.9.9'), undefined);
  assert.throws(
    () => ((builtinTemplates.list()[0]!.manifest.metadata as { name: string }).name = 'mutated'),
  );
  assert.throws(() =>
    createTemplateRegistry([builtinTemplates.list()[0]!, builtinTemplates.list()[0]!] as never),
  );
});

test('extends applies templates with deep-merge overrides (objects merge, arrays replace)', () => {
  const result = resolveManifest(
    agent(
      {
        extends: 'template:research-analyst@1.0.0',
        policy: { maxChildren: 2 },
        skills: [{ id: 'custom', name: 'Custom', description: 'Custom skill.' }],
      },
      { name: 'my-researcher', labels: { owner: 'me' } },
    ),
  );
  const { manifest } = result;
  assert.deepEqual(result.base, {
    kind: 'template',
    ref: 'template:research-analyst@1.0.0',
    sameOwner: true,
  });
  assert.equal(manifest.metadata.name, 'my-researcher');
  assert.equal(manifest.metadata.displayName, 'Research analyst');
  assert.deepEqual(manifest.metadata.labels, { template: 'research-analyst', owner: 'me' });
  assert.equal(manifest.spec.policy.maxChildren, 2);
  assert.equal(manifest.spec.policy.maxDepth, 1, 'unset policy keys inherit');
  assert.deepEqual(
    manifest.spec.skills.map((s) => s.id),
    ['custom'],
    'arrays replace',
  );
  assert.equal(manifest.spec.extends, 'template:research-analyst@1.0.0');
  assert.deepEqual(manifest.spec.capabilities, ['research']);
  // Changing runtime mode replaces the runtime object instead of inheriting the platform model.
  const external = resolveManifest(
    agent({ extends: 'template:extractor@1.0.0', runtime: { mode: 'external' } }),
  ).manifest;
  assert.deepEqual(external.spec.runtime, { mode: 'external' });
  const missing = () => resolveManifest(agent({ extends: 'template:nope@1.0.0' }));
  assert.throws(
    missing,
    (e: unknown) => e instanceof ManifestError && e.issues[0]!.code === 'TEMPLATE_NOT_FOUND',
  );
  assert.throws(
    () => resolveManifest(agent({ extends: 'template:research-team@1.0.0' })),
    (e: unknown) => e instanceof ManifestError && e.issues[0]!.code === 'TEMPLATE_KIND_MISMATCH',
  );
  assert.throws(
    () => resolveManifest(agent({ runtime: { mode: 'hosted' } })),
    (e: unknown) =>
      e instanceof ManifestError && e.issues.some((i) => i.path === 'spec.capabilities'),
  );
});

test('forks: same-owner forks override freely, other-owner forks may only tighten policy', () => {
  const parent = resolveManifest(
    agent(
      {
        ...hosted,
        tools: { mcpServers: [{ name: 'docs', url: 'https://mcp.example.org/mcp' }] },
        policy: {
          budgetUsd: 5,
          maxChildren: 2,
          maxDepth: 2,
          allowedDomains: ['*.example.org'],
          approvalRequiredFor: ['spend'],
        },
        visibility: 'public',
      },
      { name: 'parent' },
    ),
  ).manifest;
  const id = '11111111-1111-4111-8111-111111111111';
  const loader =
    (sameOwner: boolean, visibility = parent.spec.visibility): AgentLoader =>
    (agentId, revision) =>
      agentId === id && revision === 3
        ? { sameOwner, manifest: { ...parent, spec: { ...parent.spec, visibility } } }
        : undefined;
  const fork = (spec: Record<string, unknown>) =>
    agent({ extends: `agent:${id}@3`, ...spec }, { name: 'fork' });
  const loosened = fork({
    policy: {
      budgetUsd: 10,
      maxDepth: 3,
      allowedDomains: ['evil.example.net'],
      approvalRequiredFor: [],
    },
    tools: { mcpServers: [{ name: 'x', url: 'https://mcp.example.net/mcp' }] },
  });
  assert.equal(
    resolveManifest(loosened, builtinTemplates, loader(true)).manifest.spec.policy.budgetUsd,
    10,
  );
  assert.throws(
    () => resolveManifest(loosened, builtinTemplates, loader(false)),
    (e: unknown) =>
      e instanceof ManifestError &&
      JSON.stringify(e.issues.map((i) => [i.code, i.path])) ===
        JSON.stringify([
          ['POLICY_LOOSENED', 'spec.policy.budgetUsd'],
          ['POLICY_LOOSENED', 'spec.policy.maxDepth'],
          ['POLICY_LOOSENED', 'spec.policy.allowedDomains[0]'],
          ['POLICY_LOOSENED', 'spec.policy.approvalRequiredFor'],
          ['TOOLS_EXPANDED', 'spec.tools.mcpServers[0]'],
        ]),
  );
  const tightened = resolveManifest(
    fork({
      policy: {
        budgetUsd: 1,
        allowedDomains: ['api.example.org'],
        approvalRequiredFor: ['spend', 'tool-call'],
      },
    }),
    builtinTemplates,
    loader(false),
  );
  assert.deepEqual(tightened.base, { kind: 'agent', ref: `agent:${id}@3`, sameOwner: false });
  assert.equal(tightened.manifest.metadata.name, 'fork');
  assert.throws(
    () => resolveManifest(fork({}), builtinTemplates, loader(false, 'private')),
    (e: unknown) => e instanceof ManifestError && e.issues[0]!.code === 'FORK_NOT_PERMITTED',
  );
  assert.throws(
    () => resolveManifest(agent({ extends: `agent:${id}@4` }), builtinTemplates, loader(true)),
    (e: unknown) => e instanceof ManifestError && e.issues[0]!.code === 'AGENT_NOT_FOUND',
  );
  assert.throws(
    () => resolveManifest(fork({})),
    (e: unknown) => e instanceof ManifestError && e.issues[0]!.code === 'AGENT_LOADER_UNAVAILABLE',
  );
});

test('manifest hash is stable across key order and changes with content', () => {
  const a = resolveManifest({
    apiVersion: MANIFEST_API_VERSION,
    kind: 'Agent',
    metadata: { name: 'helper', labels: { b: '2', a: '1' } },
    spec: {
      capabilities: ['extract'],
      runtime: { mode: 'hosted' },
      policy: { maxDepth: 2, budgetUsd: 0 },
    },
  });
  const b = resolveManifest({
    spec: {
      policy: { budgetUsd: 0, maxDepth: 2 },
      runtime: { mode: 'hosted' },
      capabilities: ['extract'],
    },
    metadata: { labels: { a: '1', b: '2' }, name: 'helper' },
    kind: 'Agent',
    apiVersion: MANIFEST_API_VERSION,
  });
  assert.match(a.manifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.manifestHash, b.manifestHash);
  // Explicit defaults resolve to the same document as omitted defaults.
  const c = resolveManifest(
    agent(
      { ...hosted, visibility: 'private', policy: { maxDepth: 2 } },
      { labels: { a: '1', b: '2' } },
    ),
  );
  assert.equal(c.manifestHash, a.manifestHash);
  const d = resolveManifest(
    agent({ ...hosted, policy: { maxDepth: 1 } }, { labels: { a: '1', b: '2' } }),
  );
  assert.notEqual(d.manifestHash, a.manifestHash);
});

// ---------------------------------------------------------------------------------------------
// Planning

test('planTeam: fresh create of the research team is zero-cost and deterministic', () => {
  const plan = planTeam(researchTeam(), context());
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(
    plan.agents.map((a) => [a.action, a.name]),
    [
      ['create', 'requester'],
      ['create', 'researcher'],
      ['create', 'checker'],
    ],
  );
  assert.deepEqual(
    plan.connections.map((c) => [c.action, c.from, c.to]),
    [
      ['create', 'requester', 'researcher'],
      ['create', 'researcher', 'checker'],
    ],
  );
  assert.equal(plan.requiresApproval, false);
  assert.deepEqual(plan.summary, { create: 3, update: 0, noop: 0, connectionsToCreate: 2 });
  assert.equal(plan.agents[2]!.manifest.spec.extends, 'template:fact-checker@1.0.0');
  assert.equal(plan.agents[2]!.manifest.metadata.name, 'checker');
  assert.match(plan.team!.teamHash!, /^sha256:/);
  assert.deepEqual(planTeam(researchTeam(), context()), plan);
});

test('planTeam: re-planning an applied team yields only no-ops', () => {
  const first = planTeam(researchTeam(), context());
  const again = planTeam(researchTeam(), applied(first));
  assert.equal(again.ok, true);
  assert.deepEqual(
    again.agents.map((a) => a.action),
    ['noop', 'noop', 'noop'],
  );
  assert.deepEqual(
    again.connections.map((c) => c.action),
    ['noop', 'noop'],
  );
  assert.deepEqual(again.summary, { create: 0, update: 0, noop: 3, connectionsToCreate: 0 });
  assert.equal(again.team!.teamHash, first.team!.teamHash);
  assert.equal(again.quota.agentsToCreate, 0);
});

test('planTeam: a changed member becomes an update listing changed fields', () => {
  const first = planTeam(researchTeam(), context());
  const changed = researchTeam();
  (changed.spec.members[1]!.manifest as { spec: Record<string, unknown> }).spec.instructions =
    'New instructions.';
  const plan = planTeam(changed, applied(first));
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.agents.map((a) => a.action),
    ['noop', 'update', 'noop'],
  );
  assert.deepEqual(plan.agents[1]!.changes, ['spec.instructions']);
  assert.equal(plan.agents[1]!.previousHash, first.agents[1]!.manifestHash);
  assert.notEqual(plan.team!.teamHash, first.team!.teamHash);
  const name = context({ existingAgents: [{ id: 'x', name: 'researcher', manifestHash: null }] });
  assert.ok(planTeam(researchTeam(), name).errors.some((e) => e.code === 'NAME_CONFLICT'));
  // Revoked agents do not block re-creation.
  const revoked = context({
    existingAgents: [{ id: 'x', name: 'researcher', manifestHash: null, revoked: true }],
  });
  assert.equal(planTeam(researchTeam(), revoked).ok, true);
});

test('planTeam: detects cycles, self-connections, unknown members and missing coordinators', () => {
  const cyclic = researchTeam();
  cyclic.spec.connections.push({ from: 'checker', to: 'requester' });
  let plan = planTeam(cyclic, context());
  assert.equal(plan.ok, false);
  const cycle = plan.errors.find((e) => e.code === 'CONNECTION_CYCLE');
  assert.ok(cycle);
  assert.match(cycle.message, /requester → researcher → checker → requester/);
  const self = researchTeam();
  self.spec.connections.push(
    { from: 'checker', to: 'checker' },
    { from: 'requester', to: 'ghost' },
    { from: 'requester', to: 'researcher' },
  );
  plan = planTeam(self, context());
  assert.deepEqual(
    plan.errors.map((e) => [e.code, e.path]),
    [
      ['SELF_CONNECTION', 'spec.connections[2]'],
      ['UNKNOWN_MEMBER', 'spec.connections[3].to'],
      ['DUPLICATE_CONNECTION', 'spec.connections[4]'],
    ],
  );
  const coordinator = researchTeam();
  coordinator.spec.coordinator = 'boss';
  assert.ok(
    planTeam(coordinator, context()).errors.some(
      (e) => e.code === 'COORDINATOR_MISSING' && e.path === 'spec.coordinator',
    ),
  );
  const deep = researchTeam();
  deep.spec.policy.maxDepth = 1;
  assert.ok(
    planTeam(deep, context()).errors.some(
      (e) => e.code === 'DEPTH_EXCEEDED' && e.path === 'spec.policy.maxDepth',
    ),
  );
  const fanout = researchTeam();
  fanout.spec.connections.push({ from: 'requester', to: 'checker' });
  assert.ok(
    planTeam(fanout, context()).errors.some(
      (e) =>
        e.code === 'CHILDREN_EXCEEDED' &&
        e.path === 'spec.members[0].manifest.spec.policy.maxChildren',
    ),
  );
  const orphan = researchTeam();
  orphan.spec.connections.pop();
  const warned = planTeam(orphan, context());
  assert.equal(warned.ok, true);
  assert.deepEqual(
    warned.warnings.map((w) => [w.code, w.path]),
    [['UNREACHABLE_MEMBER', 'spec.members[2]']],
  );
});

test('planTeam: quota and limit checks refuse over-capacity plans', () => {
  const full = context({
    existingAgents: Array.from({ length: 98 }, (_, i) => ({
      id: `id-${i}`,
      name: `a${i}`,
      manifestHash: 'sha256:x',
    })),
  });
  const plan = planTeam(researchTeam(), full);
  assert.equal(plan.ok, false);
  assert.deepEqual(
    plan.errors.map((e) => e.code),
    ['QUOTA_EXCEEDED'],
  );
  assert.equal(plan.quota.agentsAfter, 101);
  assert.equal(
    planTeam(researchTeam(), context({ quotas: { remaining: { agents: 2 } } })).ok,
    false,
  );
  assert.equal(
    planTeam(researchTeam(), context({ quotas: { remaining: { connections: 1 } } })).ok,
    false,
  );
  assert.equal(
    planTeam(
      researchTeam(),
      context({ limits: { agentsPerWorkspace: 100, connectionsPerWorkspace: 1 } }),
    ).ok,
    false,
  );
  assert.equal(
    planTeam(researchTeam(), context({ quotas: { remaining: { agents: 3, connections: 2 } } })).ok,
    true,
  );
});

test('planTeam: budgets and paid models require approval; member budgets fit the tree budget', () => {
  const paid = researchTeam();
  const researcher = paid.spec.members[1]!.manifest as { spec: Record<string, unknown> };
  researcher.spec.runtime = {
    mode: 'hosted',
    model: { provider: 'anthropic', name: 'claude-model' },
  };
  researcher.spec.policy = { maxChildren: 1, budgetUsd: 2.5 };
  let plan = planTeam(paid, context());
  assert.deepEqual(
    plan.errors.map((e) => e.code),
    ['TEAM_BUDGET_EXCEEDED'],
  );
  paid.spec.policy.budgetUsd = 5;
  plan = planTeam(paid, context());
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.requiresApproval, true);
  assert.deepEqual(
    plan.approvals.map((a) => [a.code, a.path]),
    [
      ['BUDGET_NONZERO', 'spec.members[1].manifest.spec.policy.budgetUsd'],
      ['PAID_MODEL', 'spec.members[1].manifest.spec.runtime.model.provider'],
      ['BUDGET_NONZERO', 'spec.policy.budgetUsd'],
    ],
  );
  assert.equal(plan.agents[1]!.requiresApproval, true);
  assert.equal(plan.agents[0]!.requiresApproval, false);
  assert.equal(plan.quota.budgetUsdRequested, 2.5);
  assert.equal(planTeam(paid, context({ quotas: { remaining: { budgetUsd: 1 } } })).ok, false);
  // Once applied (approved), re-planning is a no-op and needs no further approval.
  assert.equal(planTeam(paid, applied(plan)).requiresApproval, false);
});

test('planTeam: member resolution and capability errors carry document paths', () => {
  const broken = researchTeam();
  broken.spec.members[2] = { name: 'checker', ref: 'template:missing@1.0.0' };
  (broken.spec.members[1]!.manifest as { spec: Record<string, unknown> }).spec.capabilities = [
    'translate',
  ];
  const plan = planTeam(broken, context());
  assert.deepEqual(
    plan.errors.map((e) => [e.code, e.path]),
    [
      ['CAPABILITY_UNSUPPORTED', 'spec.members[1].manifest.spec.capabilities[0]'],
      ['TEMPLATE_NOT_FOUND', 'spec.members[2].ref'],
    ],
  );
  const invalid = planTeam(
    { kind: 'Team', apiVersion: MANIFEST_API_VERSION, metadata: { name: 't' }, spec: {} },
    context(),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.team, null);
  const single = planAgent(
    agent({ extends: 'template:extractor@1.0.0' }, { name: 'solo' }),
    context(),
  );
  assert.equal(single.ok, true);
  assert.deepEqual(
    single.agents.map((a) => [a.action, a.name]),
    [['create', 'solo']],
  );
  const a2a = planAgent(
    agent({
      capabilities: ['research'],
      runtime: { mode: 'a2a', endpoint: 'https://agents.example.org/a2a' },
    }),
    context(),
  );
  assert.equal(a2a.ok, true);
  assert.deepEqual(
    a2a.warnings.map((w) => w.code),
    ['RUNTIME_PENDING'],
  );
});

// ---------------------------------------------------------------------------------------------
// Agent Card compilation and signing

const cardFor = (manifest: ResolvedAgentManifest) =>
  compileAgentCard(manifest, {
    agentId: '22222222-2222-4222-8222-222222222222',
    baseUrl: 'https://city.example.org/',
    provider: { organization: 'Central City', url: 'https://city.example.org' },
  });

test('Agent Card compiles to the pinned A2A 1.0 shape with native auth', () => {
  const { manifest, manifestHash } = resolveManifest(
    agent({ extends: 'template:research-analyst@1.0.0' }, { name: 'r' }),
  );
  const card = cardFor(manifest);
  assert.deepEqual(card.supportedInterfaces, [
    {
      url: 'https://city.example.org/api/runtime/a2a/22222222-2222-4222-8222-222222222222',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
  ]);
  assert.equal(card.name, 'Research analyst');
  assert.equal(card.version, `m-${manifestHash.slice(7, 19)}`);
  assert.deepEqual(
    card.capabilities.extensions.map((e) => [e.uri, e.required]),
    [['urn:central-city:a2a:native-auth:1', true]],
  );
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.securityRequirements, [{ schemes: { centralCityNative: { list: [] } } }]);
  assert.equal(card.securitySchemes.centralCityNative!.httpAuthSecurityScheme.scheme, 'Bearer');
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.deepEqual(card.defaultOutputModes, ['application/json']);
  assert.deepEqual(
    card.skills.map((s) => s.id),
    ['research-brief'],
  );
  const fallback = cardFor(resolveManifest(agent(hosted)).manifest);
  assert.deepEqual(
    fallback.skills.map((s) => [s.id, s.tags]),
    [['extract', ['extract']]],
  );
  assert.equal(fallback.description, 'helper');
  assert.throws(() =>
    compileAgentCard(manifest, {
      agentId: 'a',
      baseUrl: 'http://city.example.org',
      provider: card.provider,
    }),
  );
  assert.throws(() =>
    compileAgentCard(manifest, {
      agentId: 'bad id',
      baseUrl: 'https://city.example.org',
      provider: card.provider,
    }),
  );
  const local = compileAgentCard(manifest, {
    agentId: 'a',
    baseUrl: 'http://127.0.0.1:8787',
    provider: card.provider,
  });
  assert.equal(local.supportedInterfaces[0]!.url, 'http://127.0.0.1:8787/api/runtime/a2a/a');
});

test('Agent Card signatures verify, detect tampering and survive key rotation', () => {
  const card = cardFor(
    resolveManifest(agent({ extends: 'template:fact-checker@1.0.0' }, { name: 'c' })).manifest,
  );
  const oldKey = generateSigningKey();
  assert.match(oldKey.kid, /^[A-Za-z0-9_-]{43}$/);
  const signed = signAgentCard(card, oldKey);
  const header = JSON.parse(Buffer.from(signed.signatures![0]!.protected, 'base64url').toString());
  assert.deepEqual(header, { alg: 'EdDSA', kid: oldKey.kid, typ: 'JOSE' });
  assert.equal(verifyAgentCard(signed, exportJwks([oldKey])).valid, true);
  // Key order and re-serialization do not matter: verification uses the canonical form.
  const roundTrip = JSON.parse(JSON.stringify({ ...signed, name: signed.name })) as AgentCard;
  const reordered = Object.fromEntries(Object.entries(roundTrip).reverse()) as unknown as AgentCard;
  assert.equal(verifyAgentCard(reordered, exportJwks([oldKey])).valid, true);

  const tampered = structuredClone(signed);
  tampered.supportedInterfaces[0]!.url = 'https://attacker.example.net/a2a/x';
  assert.deepEqual(verifyAgentCard(tampered, exportJwks([oldKey])), {
    valid: false,
    results: [{ valid: false, reason: 'bad-signature' }],
  });
  const badSig = structuredClone(signed);
  badSig.signatures![0]!.signature = badSig.signatures![0]!.signature.replace(/^./, (c) =>
    c === 'A' ? 'B' : 'A',
  );
  assert.equal(verifyAgentCard(badSig, exportJwks([oldKey])).valid, false);
  const noneAlg = structuredClone(signed);
  noneAlg.signatures![0]!.protected = Buffer.from(
    JSON.stringify({ alg: 'none', kid: oldKey.kid }),
  ).toString('base64url');
  assert.deepEqual(verifyAgentCard(noneAlg, exportJwks([oldKey])).results, [
    { valid: false, reason: 'unsupported-alg' },
  ]);
  assert.equal(
    verifyAgentCard(card, exportJwks([oldKey])).valid,
    false,
    'unsigned cards are not valid',
  );

  // Rotation: sign with both keys during overlap, then retire the old key.
  const newKey = generateSigningKey('2026-09-rotation');
  assert.notEqual(newKey.kid, oldKey.kid);
  const both = signAgentCard(signed, newKey);
  assert.equal(both.signatures!.length, 2);
  assert.equal(verifyAgentCard(both, exportJwks([newKey])).valid, true);
  assert.deepEqual(
    verifyAgentCard(both, exportJwks([newKey])).results.map((r) => (r.valid ? r.kid : r.reason)),
    ['unknown-kid', '2026-09-rotation'],
  );
  assert.equal(verifyAgentCard(signed, exportJwks([newKey])).valid, false);
  assert.equal(
    signAgentCard(both, newKey).signatures!.length,
    2,
    're-signing replaces the same kid',
  );
  assert.throws(() => exportJwks([oldKey, oldKey]));
  const jwks = exportJwks([oldKey, newKey]);
  assert.deepEqual(Object.keys(jwks.keys[0]!).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x']);

  // Serialization round trip keeps the same key material and kid.
  const restored = importSigningKey(JSON.parse(JSON.stringify(exportSigningKey(newKey))));
  assert.equal(restored.kid, newKey.kid);
  assert.equal(verifyAgentCard(signAgentCard(card, restored), exportJwks([newKey])).valid, true);
  const forged = exportSigningKey(newKey);
  forged.jwk.x = exportSigningKey(oldKey).jwk.x;
  assert.throws(() => importSigningKey(forged));
});

test('issues never echo received keys or values (paths are reduced, messages are generic)', () => {
  // Paths keep only [A-Za-z0-9_-] per segment (like REST validation errors); messages never
  // repeat the key or value.
  const key = 'sk-ant-SECRET.VALUE:0123456789';
  const unknown = parseAgentManifest(agent(hosted, { labels: { team: 'blue' }, [key]: 1 }));
  assert.equal(unknown.ok, false);
  const issues = !unknown.ok ? unknown.issues : [];
  assert.deepEqual(
    issues.map(({ code, path, message }) => ({ code, path, message })),
    [
      {
        code: 'UNKNOWN_KEY',
        path: 'metadata.sk-ant-SECRET?VALUE?0123456789',
        message: 'Unknown key.',
      },
    ],
  );
  assert.ok(!JSON.stringify(issues).includes(key));
  const duplicate = parseAgentManifest(agent({ ...hosted, capabilities: ['extract', 'extract'] }));
  const dupText = JSON.stringify(!duplicate.ok && duplicate.issues);
  assert.match(dupText, /DUPLICATE_NAME/);
  assert.ok(!dupText.includes('"extract"') && !dupText.includes('extract\\"'), dupText);
});
