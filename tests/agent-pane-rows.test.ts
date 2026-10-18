import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { WalletRead, WalletView } from '../src/base/wallet/api.js';
import { WALLET_ROW_UNREAD, walletRowValue } from '../src/base/wallet/useWalletRow.js';
import {
  agentRoomsByAgent,
  MEMBERS_PAGE,
  type MembersPageRead,
} from '../src/agents/useAgentRooms.js';

/** The agent pane's Wallet and Rooms rows (src/agents/v4/AgentPane.tsx). Synthetic data only. */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

test('the Wallet row hides only when wallets are off; a failed read still shows the row', () => {
  const wallet = { usdc: { raw: '1234567', decimals: 6 } } as unknown as WalletView;
  assert.equal(walletRowValue({ kind: 'off' }), null);
  assert.equal(walletRowValue({ kind: 'wallet', wallet }), '1.234567 USDC');
  assert.equal(walletRowValue({ kind: 'none' }), 'Set up');
  assert.equal(walletRowValue({ kind: 'chain_unavailable' }), 'Base isn’t answering');
  assert.equal(
    walletRowValue({
      kind: 'registered_elsewhere',
      address: `0x${'1'.repeat(40)}`,
      ownerAddress: `0x${'2'.repeat(40)}`,
    } satisfies WalletRead),
    'In your own wallet',
  );
  assert.ok(WALLET_ROW_UNREAD, 'a network or server error leaves a visible value');
  const hook = read('src/base/wallet/useWalletRow.ts');
  assert.match(hook, /\(\) => live && setValue\(WALLET_ROW_UNREAD\)/);
});

test('the pane re-reads its Wallet and Rooms rows after changes in its screens', () => {
  // Wallet: read again on each return to the pane's home screen.
  assert.match(
    read('src/agents/v4/AgentPane.tsx'),
    /useWalletRow\(agent\.revokedAt \? null : agent\.id, top === 'home'\)/,
  );
  assert.match(read('src/base/wallet/useWalletRow.ts'), /\}, \[agentId, active\]\);/);
  // Rooms: the shell reloads the row whenever a screen reports a change ...
  assert.match(
    read('src/agents/MyAgentsV2.tsx'),
    /onChanged=\{\(\) => \{[^}]*onChanged\?\.\(\);\s*void rooms\.reload\(\);/,
  );
  // ... and leaving, adding and answering an invitation report one.
  const rooms = read('src/agents/v4/RoomsScreen.tsx');
  assert.match(rooms, /toast\.show\(`Left “\$\{name\}”`\);\s*onChanged\?\.\(\);/);
  assert.match(rooms, /idempotency_key: key\.current,\s*\}\);\s*onChanged\?\.\(\);\s*onBack\(\);/);
  for (const screen of ['MessagesScreen', 'InvitationsScreen'])
    assert.match(
      read(`src/agents/v4/${screen}.tsx`),
      /<InvitationRequests agent=\{agent\} onOpenRoom=\{onOpenRoom\} onChanged=\{onChanged\} \/>/,
      screen,
    );
});

test('the Rooms row reads every page of a large room, so late joiners are counted', async () => {
  const member = (id: string, own: boolean) => ({
    id,
    role: 'member' as const,
    own,
    kind: 'agent' as const,
  });
  // A big room: the owner's agent is on the third page; a small room and a closed one besides.
  const pages: Record<string, MembersPageRead[]> = {
    big: [
      { members: [member('other-1', false)], next_cursor: 'c1' },
      { members: [member('other-2', false)], next_cursor: 'c2' },
      { members: [member('mine', true)], next_cursor: null },
    ],
    small: [{ members: [member('mine', true), { ...member('me', true), kind: 'person' }] }],
    closed: [{ members: [member('mine', true)] }],
  };
  const calls: string[] = [];
  const byAgent = await agentRoomsByAgent(
    [
      { id: 'big', name: 'Big', closed: false },
      { id: 'small', name: 'Small', closed: false },
      { id: 'closed', name: 'Closed', closed: true },
    ],
    async (roomId, cursor) => {
      calls.push(`${roomId}:${cursor ?? ''}`);
      const index = cursor ? Number(cursor.slice(1)) : 0;
      return pages[roomId]![index]!;
    },
  );
  assert.deepEqual(calls.sort(), ['big:', 'big:c1', 'big:c2', 'small:']);
  assert.deepEqual(
    byAgent
      .get('mine')
      ?.map((room) => room.roomId)
      .sort(),
    ['big', 'small'],
  );
  assert.equal(byAgent.has('other-1'), false);
  assert.equal(byAgent.has('me'), false, 'people are not agents');
  assert.equal(MEMBERS_PAGE, 1000, "the server's largest page");
  assert.match(read('src/agents/useAgentRooms.ts'), /members\?limit=\$\{MEMBERS_PAGE\}/);
});
