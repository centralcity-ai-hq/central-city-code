import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { keccak256, toHex, type Hex } from 'viem';

/*
 * The fee routers' deploy kits (contracts/deploy-kit/router*.json) are what the owner deploys from,
 * and their hashes are what the deploy page approves. Each kit must be exactly the repository's
 * contract source compiled with the kit's own recorded settings and source unit: a changed source,
 * setting or kit file fails here instead of at deploy time.
 */
const require = createRequire(import.meta.url);
const solc = require('solc') as { compile(input: string): string; version(): string };

interface Kit {
  contract: string;
  compiler: string;
  sourceUnit: string;
  settings: Record<string, unknown>;
  sourceSha: Hex;
  bytecodeSha: Hex;
  runtimeSize: number;
  runtimeMaskedSha: Hex;
  immutables: Record<string, { start: number; length: number }[]>;
  abi: unknown[];
  bytecode: Hex;
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

for (const file of ['router.json', 'router2.json', 'router3.json']) {
  test(`deploy kit ${file}: built from the repository source with its recorded settings`, () => {
    const kit = JSON.parse(read(`contracts/deploy-kit/${file}`)) as Kit;
    assert.equal(kit.sourceUnit, `fees/${kit.contract}.sol`);
    assert.equal(kit.compiler, `solc ${solc.version()}`, 'the pinned compiler');
    const content = read(`contracts/${kit.sourceUnit}`);
    assert.equal(keccak256(toHex(content)), kit.sourceSha, 'sourceSha is the source as committed');
    const out = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: 'Solidity',
          sources: { [kit.sourceUnit]: { content } },
          settings: {
            ...kit.settings,
            outputSelection: {
              '*': {
                '': ['ast'],
                '*': [
                  'abi',
                  'evm.bytecode.object',
                  'evm.deployedBytecode.object',
                  'evm.deployedBytecode.immutableReferences',
                ],
              },
            },
          },
        }),
      ),
    ) as {
      errors?: { severity: string; message: string }[];
      contracts: Record<
        string,
        Record<
          string,
          {
            abi: unknown[];
            evm: {
              bytecode: { object: string };
              deployedBytecode: {
                object: string;
                immutableReferences: Record<string, { start: number; length: number }[]>;
              };
            };
          }
        >
      >;
      sources: Record<string, { ast: unknown }>;
    };
    const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
    assert.deepEqual(errors, []);
    const compiled = out.contracts[kit.sourceUnit]![kit.contract]!;
    const bytecode = `0x${compiled.evm.bytecode.object}` as Hex;
    assert.equal(bytecode, kit.bytecode, 'the kit bytecode is the compiled source');
    assert.equal(keccak256(bytecode), kit.bytecodeSha, 'bytecodeSha is the kit bytecode');
    assert.deepEqual(compiled.abi, kit.abi);
    // The runtime record the deploy page's read-back checks (CCA-132): the compiled runtime code
    // (immutables still zero), its size, and each immutable's byte ranges by name.
    const runtime = `0x${compiled.evm.deployedBytecode.object}` as Hex;
    assert.equal(kit.runtimeMaskedSha, keccak256(runtime));
    assert.equal(kit.runtimeSize, (runtime.length - 2) / 2);
    const names = new Map<string, string>();
    (function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      const n = node as { nodeType?: string; id?: number; name?: string; mutability?: string };
      if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable')
        names.set(String(n.id), n.name!);
      for (const value of Object.values(node)) walk(value);
    })(out.sources[kit.sourceUnit]!.ast);
    const byName = Object.fromEntries(
      Object.entries(compiled.evm.deployedBytecode.immutableReferences).map(([id, ranges]) => [
        names.get(id),
        ranges,
      ]),
    );
    assert.deepEqual(Object.keys(byName).sort(), ['token', 'treasury']);
    assert.deepEqual(kit.immutables, byName);
  });
}

test("the deploy page's approved bytecode hashes are the kits' bytecodeSha (CCA-129)", () => {
  const page = read('contracts/deploy-kit/deploy.html');
  const block = /const APPROVED_BYTECODE_SHA = \{([^}]*)\}/.exec(page);
  assert.ok(block, 'deploy.html declares APPROVED_BYTECODE_SHA');
  const approved = Object.fromEntries(
    [...block[1]!.matchAll(/(\d+):\s*'(0x[0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]),
  );
  const kits: Record<string, string> = { 1: 'router.json', 2: 'router2.json', 3: 'router3.json' };
  assert.deepEqual(Object.keys(approved).sort(), Object.keys(kits).sort(), 'one hash per router');
  for (const [n, file] of Object.entries(kits)) {
    const kit = JSON.parse(read(`contracts/deploy-kit/${file}`)) as Kit;
    assert.equal(approved[n], kit.bytecodeSha, `router ${n}: the page approves ${file}`);
  }
});

test('the treasury-replacement runbook covers all three routers and every place that names them (CCA-124)', () => {
  const runbook = read('docs/protocol/TREASURY_REPLACEMENT.md');
  for (const router of ['CentralCityFeeRouter', 'CentralCityFeeRouter2', 'CentralCityFeeRouter3'])
    assert.ok(runbook.includes(`\`${router}\``), router);
  for (const step of ['deploy.html?router=2', 'deploy.html?router=3', 'ROUTER1_TREASURY'])
    assert.ok(runbook.includes(step), step);
  // Every router, treasury and deploy-block field of the Base mainnet deployment.
  const protocol = read('shared/protocol.ts');
  const fields = /export interface ProtocolDeployment \{([\s\S]*?)\n\}/.exec(protocol)![1]!;
  for (const [, field] of fields.matchAll(/readonly (\w+):/g))
    if (/router|treasury/i.test(field!)) assert.ok(runbook.includes(`\`${field}\``), field);
  // Every protocol switch and test-network variable that names a router, treasury or start block.
  for (const [name] of new Set(
    [
      ...read('server/protocol/fees/cron.ts').matchAll(
        /CITY_PROTOCOL_(?:FEE_ROUTER\w*|ROUTER|TREASURY|START_BLOCK)\b/g,
      ),
    ].map((m) => m[0]),
  ).entries())
    assert.ok(runbook.includes(`\`${name}\``), name);
  assert.ok(runbook.includes('`CITY_PROTOCOL_FEES=0`'), 'stop new fees first');
  for (const doc of [
    'CANARY.md',
    'FEE_ROUTER_2.md',
    'FEE_ROUTER_3.md',
    'FEES.md',
    'DEFILLAMA_ADAPTER.md',
  ])
    assert.ok(runbook.includes(`(${doc})`), doc);
  assert.match(
    read('docs/protocol/FEES.md'),
    /\[TREASURY_REPLACEMENT\.md\]\(TREASURY_REPLACEMENT\.md\) records a contingency design/,
  );
});

test('the treasury replacement is contingency design only, and CCA-124 is not claimed fixed (#813)', () => {
  const runbook = read('docs/protocol/TREASURY_REPLACEMENT.md');
  const head = runbook.slice(0, runbook.indexOf('\n## '));
  assert.match(head, /\*\*Status: contingency design only\. This is not an owner action/);
  assert.match(
    head,
    /deploying new contracts and changing any protocol address[\s\S]*are prohibited/,
  );
  assert.match(head, /CCA-124[\s\S]*stays open/);
  assert.doesNotMatch(runbook, /CCA-124[^.]*\b(is|was|now) (fixed|resolved|closed)\b/i);
  // No runnable deploy instructions: no command to serve the kit, no imperative deploy step.
  assert.doesNotMatch(runbook, /serve-deploy-kit|^\s*\d+\.\s+(Connect|Deploy|Run|Set|Submit)\b/m);
  // The threat model states the owner-key custody as a requirement, not as the current state.
  const threat = read('docs/THREAT_MODEL.md');
  assert.doesNotMatch(threat, /owner key, which is held by the owner/);
  assert.match(threat, /this key must be held offline by the owner and never be on a server/);
});
