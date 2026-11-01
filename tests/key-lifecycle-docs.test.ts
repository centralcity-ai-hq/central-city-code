import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

test('CCA-139: orphaned spender keys are not claimed to be deleted while nothing schedules it', () => {
  const callers = ['server', 'api', 'scripts']
    .flatMap(files)
    .filter((file) => file !== join('server', 'base', 'chain', 'stores.ts'))
    .filter((file) => /\bdeleteOrphans\s*\(/.test(read(file)));
  // No scheduled caller exists, so the schema and store must not say orphans "are deleted".
  assert.deepEqual(callers, []);
  assert.doesNotMatch(read('server/base/schema.ts'), /are orphans and are deleted/);
  assert.doesNotMatch(read('server/base/chain/stores.ts'), /older than this are deleted/);
  // The KEK retirement procedure the re-wrap script points to exists.
  const architecture = read('docs/base/ARCHITECTURE.md');
  assert.match(architecture, /#### Spender KEK lifecycle/);
  for (const step of [
    /rewrap-spender-keys\.ts/,
    /"walletKeys":0/,
    /Service keys .*never moved by the script/s,
    /"pending":0/,
    /Remove the old version/,
  ])
    assert.match(architecture, step);
});

test('CCA-141: the owner-key blast radius and an incident runbook are written down', () => {
  const model = read('docs/base/WALLET-THREAT-MODEL.md');
  assert.match(model, /## Owner-key compromise/);
  assert.match(model, /\*\*Blast radius\.\*\*[\s\S]*every agent wallet of that person at\s+once/);
  assert.match(model, /\*\*Today there is no rotation path\.\*\*/);
  assert.match(model, /\*\*Incident runbook/);
  assert.match(model, /addOwnerAddress\(newOwner\)[\s\S]*removeOwnerAtIndex/);
  assert.match(model, /\[Owner-key compromise\]\(#owner-key-compromise\)/);
  // The decoder still refuses owner changes: the runbook must not promise a rotation that exists.
  assert.doesNotMatch(read('shared/base/withdraw.ts'), /addOwnerAddress|removeOwnerAtIndex/);
});

test('CCA-143: the docs say one owner’s agent wallets are linkable on Base; no comment claims otherwise', () => {
  const flat = (path: string) => read(path).replace(/\s+/g, ' ');
  const model = flat('docs/base/WALLET-THREAT-MODEL.md');
  assert.match(model, /An owner's agent wallets are linkable on Base\./);
  assert.match(model, /anyone can see on Base that they share an owner/);
  assert.match(
    model,
    /Not a privacy control on Base: one owner's agent wallets share the owner key/,
  );
  // The restricted threat model states it; the public guides do not repeat withheld audit material.
  assert.doesNotMatch(flat('docs/WALLET_GUIDE.md'), /share the same owner key/);
  const store = flat('server/base/explorer/store.ts');
  assert.match(store, /does not make one owner's agents unlinkable/);
  assert.doesNotMatch(store, /learn which agents share an owner/);
  // Still true in code: an agent wallet's owners are the person's owner key and the manager.
  // When per-agent owner keys land, this test and the docs change together.
  assert.match(
    read('server/base/chain/derive.ts'),
    /owners: \[getAddress\(owner\), network\.contracts\.spendPermissionManager\]/,
  );
});

test('CCA-643: the docs say the runtime signature is keyed by the bearer it travels with', () => {
  const threat = read('docs/THREAT_MODEL.md');
  assert.match(threat, /runtime request signature is keyed by the same bearer secret/);
  assert.match(threat, /integrity and replay protection[^.]*only/);
  assert.match(threat, /anyone who can read one request[^.]*can sign new ones/);
  const connector = read('docs/CONNECTOR.md');
  assert.match(connector, /same secret the `Authorization` header carries/);
  assert.match(connector, /must be sent as `Content-Type: application\/json`/);
  // The connector really signs with the bearer: the docs describe the code, not a plan.
  assert.match(read('connector/signing.ts'), /createHmac\('sha256', token\)/);
});

test('CCA-644: the rate-limit root key has a rotation procedure that names its side effects', () => {
  const ops = read('docs/OPERATIONS.md');
  assert.match(ops, /### The rate-limit root key \(`CITY_RATE_LIMIT_KEY`\)/);
  for (const effect of [
    /Room link tokens/,
    /short codes/,
    /rejoin links/,
    /Google relink cooldowns/,
    /Wake webhook root/,
    /Counters and buckets start fresh/,
  ])
    assert.match(ops, effect);
  assert.match(ops, /Set `CITY_WAKE_SECRET` first/);
  assert.match(ops, /\*\*Planned separation/);
  // Still true in code: one root feeds the room links and the short codes. When the planned
  // separation lands, this test and the section change together.
  assert.match(read('server/app.ts'), /const roomsSecret = process\.env\.CITY_RATE_LIMIT_KEY/);
  assert.match(read('server/links/short-code.ts'), /process\.env\.CITY_RATE_LIMIT_KEY/);
});
