import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encodePacked, getContractAddress, keccak256 } from 'viem';
import { expectedCode, REPLAYS, replayAddress } from '../scripts/arc/replay-deploys.js';
import { BASE_MAINNET } from '../shared/base/chains.js';

test('a replay lands where CREATE2 says: 32-byte salt, then init code, no selector', () => {
  const deployer = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  const salt = `0x${'ab'.repeat(32)}` as const;
  const init = '0x60006000f3' as const;
  assert.equal(
    replayAddress(deployer, encodePacked(['bytes32', 'bytes'], [salt, init])),
    getContractAddress({ opcode: 'CREATE2', from: deployer, salt, bytecode: init }),
  );
  assert.ok(keccak256(init));
});

test('dependencies come first: factory after implementation, manager after validator', () => {
  const at = (name: string) => REPLAYS.findIndex((r) => r.name === name);
  assert.ok(at('CoinbaseSmartWallet implementation') < at('CoinbaseSmartWalletFactory'));
  assert.ok(at('PublicERC6492Validator') < at('SpendPermissionManager'));
});

test('mainnet is never sent from the script', () => {
  const source = readFileSync('scripts/arc/replay-deploys.ts', 'utf8');
  assert.match(source, /if \(send && chainId !== ARC_TESTNET\) throw/);
});

test('nothing on the server calls spendWithWithdraw: on Arc MagicSpend has no code', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  for (const file of [...walk('server'), ...walk('shared')])
    assert.ok(!readFileSync(file, 'utf8').includes('spendWithWithdraw'), file);
});

test('expected code: only the chain id and domain separator change, and only once each', () => {
  const manager = REPLAYS.find((r) => r.eip712)!;
  const word = (n: number) => n.toString(16).padStart(64, '0');
  const separator = (id: number) =>
    expectedCode(manager, `0x${word(BASE_MAINNET)}${word(0)}` as never, id);
  assert.throws(() => separator(5042002), /not once/);
  const plain = REPLAYS.find((r) => !r.eip712)!;
  assert.equal(expectedCode(plain, '0xabcd', 5042002), '0xabcd');
});
