import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { choseArc, forgetChains, rememberChain, rememberedChain } from '../src/base/chosenChain';
import { expectedWallet } from '../src/base/wallet/derive';

/* Operation Arc: the chosen chain carries through the wallet key's setup and the wallet screens. */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const AGENT = 'arc-carry-0000-4000-8000-000000000000';

test('the chosen chain is remembered per agent; only Base and Arc networks count', () => {
  forgetChains();
  assert.equal(rememberedChain(AGENT), undefined);
  assert.equal(choseArc(AGENT), false);
  rememberChain(AGENT, 5042);
  assert.equal(rememberedChain(AGENT), 5042);
  assert.equal(choseArc(AGENT), true);
  assert.equal(choseArc('another-agent'), false);
  rememberChain(AGENT, 8453);
  assert.equal(choseArc(AGENT), false);
  rememberChain(AGENT, 1);
  assert.equal(rememberedChain(AGENT), 8453, 'an unknown chain is ignored');
  forgetChains();
});

test('the Base screen remembers the choice and the chain the server names', () => {
  const screen = read('src/agents/v4/BaseScreen.tsx');
  assert.match(screen, /rememberChain\(agentId, picked\)/);
  assert.match(screen, /rememberChain\(agentId, serverChain\)/);
  assert.match(screen, /useState<ChainChoice \| undefined>\(\s*\(\) => rememberedChain\(agentId\)/);
  // The key's wallet is derived on the agent's chain.
  assert.match(screen, /useRegisterWithKey\(agentId, idle, chainId\)/);
});

test('with Arc chosen the Wallet screen makes no Base wallet and sends the owner to register', () => {
  const wallet = read('src/agents/v4/WalletScreen.tsx');
  assert.match(wallet, /if \(choseArc\(agent\.id\)\) return setStep\(\{ k: 'arc-register' \}\)/);
  assert.match(wallet, /return choseArc\(agent\.id\) \|\| unasked \? load\(\) : create\(\)/);
  // A closed tab forgets the choice: asked again, never a Base wallet by not being asked.
  assert.match(
    wallet,
    /arcOn && rememberedChain\(agent\.id\) === undefined\) return setStep\(\{ k: 'choose-chain' \}\)/,
  );
  assert.match(wallet, /Register \$\{agent\.name\} on Arc/);
});

test('the back link to the identity screen names the remembered chain', () => {
  const pane = read('src/agents/v4/AgentPane.tsx');
  assert.match(
    pane,
    /if \(name === 'base'\) return chainWords\(rememberedChain\(agent\.id\)\)\.on;/,
  );
  assert.match(pane, /<Row label=\{IDENTITY_ROW_LABEL\} k="row-base"/);
});

test('the key derives its Arc wallet on Arc: same factory, so the same address as on Base', () => {
  const owner = `0x${'11'.repeat(20)}`;
  const arc = expectedWallet(owner, AGENT, 5042);
  assert.match(arc, /^0x[0-9a-fA-F]{40}$/);
  const hook = read('src/base/useRegisterWithKey.ts');
  assert.match(hook, /chainId === ARC_MAINNET \|\| chainId === ARC_TESTNET/);
});
