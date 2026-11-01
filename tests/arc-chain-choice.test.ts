import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseRegistrationController } from '../src/base/baseRegistrationController';
import {
  ARC_CHAIN_ID,
  BASE_MAINNET,
  CHAIN_OPTIONS,
  chainFields,
  chainChangeShown,
  chainStepShown,
  otherChainMessage,
  otherChainText,
} from '../src/base/baseRegistrationModel';
import { ARC_MAINNET } from '../shared/chains';

/* Operation Arc: Choose a chain before the Base screen's start, and what the register call carries. */

const OWNER = `0x${'aa'.repeat(20)}`;
let ids = 0;
const agent = () => `arc-${++ids}-0000-4000-8000-000000000000`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function server(registerReply: { status: number; body: unknown }) {
  const posts: Record<string, unknown>[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(registerReply.body), { status: registerReply.status });
    }
    return new Response(JSON.stringify({ identities: [] }), { status: 200 });
  }) as typeof globalThis.fetch;
  return {
    posts,
    deps: { fetch, setTimeout: () => 0, clearTimeout: () => undefined, now: () => 0 },
  };
}

async function register(chainId: number | null, reply: { status: number; body: unknown }) {
  const h = server(reply);
  const c = new BaseRegistrationController(agent(), 'ws-arc', { deps: h.deps });
  c.start();
  await settle();
  if (chainId !== null) c.setChain(chainId);
  c.setAddress(OWNER);
  c.submit();
  await settle();
  await settle();
  return { posts: h.posts, snap: c.getSnapshot() };
}

const ok = {
  status: 200,
  body: { identity: { state: 'pending', erc8004AgentId: null, agentUri: '' } },
};

test('Arc mainnet is the shared chain id and the options are Base then Arc', () => {
  assert.equal(ARC_CHAIN_ID, ARC_MAINNET);
  assert.equal(ARC_CHAIN_ID, 5042);
  assert.deepEqual(
    CHAIN_OPTIONS.map((o) => o.chainId),
    [BASE_MAINNET, ARC_CHAIN_ID],
  );
});

test('the step shows only while Arc is on and the agent is not onchain yet', () => {
  assert.equal(chainStepShown({ arcOn: true, identity: null, wallet: null }), true);
  assert.equal(chainStepShown({ arcOn: false, identity: null, wallet: null }), false);
  assert.equal(chainStepShown({ arcOn: true, identity: null, wallet: { address: OWNER } }), false);
  assert.equal(
    chainStepShown({
      arcOn: true,
      identity: { state: 'failed', erc8004AgentId: null, agentUri: '' },
      wallet: null,
    }),
    false,
  );
});

test('Base sends no chainId (as before); Arc sends 5042', async () => {
  assert.deepEqual(chainFields(BASE_MAINNET), {});
  assert.deepEqual(chainFields(ARC_CHAIN_ID), { chainId: 5042 });
  const untouched = await register(null, ok);
  const base = await register(BASE_MAINNET, ok);
  const arc = await register(ARC_CHAIN_ID, ok);
  assert.deepEqual(untouched.posts, [{ ownerAddress: OWNER }]);
  assert.equal(JSON.stringify(base.posts), JSON.stringify(untouched.posts));
  assert.deepEqual(arc.posts, [{ ownerAddress: OWNER, chainId: 5042 }]);
});

test('409 other_chain says where the agent lives; other errors as before', async () => {
  assert.equal(otherChainMessage({ chainId: 8453 }), 'This agent already lives on Base.');
  assert.equal(otherChainMessage({ chain: 'Arc' }), 'This agent already lives on Arc.');
  assert.equal(otherChainMessage(undefined), 'This agent already lives on another chain.');
  const refused = await register(ARC_CHAIN_ID, {
    status: 409,
    body: {
      error: 'This agent is already on another chain. An agent has one chain for now.',
      code: 'other_chain',
      details: { chainId: 8453 },
    },
  });
  // The register button shows the server's message, never just the same screen again.
  assert.equal(
    refused.snap.error,
    'This agent already lives on Base. An agent has one chain for now.',
  );
  assert.equal(refused.snap.busy, false);
  const topLevel = await register(ARC_CHAIN_ID, {
    status: 409,
    body: {
      error: 'This agent is already on another chain. An agent has one chain for now.',
      code: 'other_chain',
      chainId: 8453,
    },
  });
  assert.equal(
    topLevel.snap.error,
    'This agent already lives on Base. An agent has one chain for now.',
  );
  const other = await register(ARC_CHAIN_ID, { status: 400, body: { error: 'Bad owner.' } });
  assert.notEqual(other.snap.error, '');
  assert.doesNotMatch(other.snap.error, /lives on/);
});

test('after a reload an Arc agent is read on Arc, and its next register call carries Arc', async () => {
  const posts: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(ok.body), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        identities: [
          { chainId: ARC_CHAIN_ID, state: 'pending', erc8004AgentId: null, agentUri: '' },
        ],
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
  const c = new BaseRegistrationController(agent(), 'ws-arc', {
    deps: { fetch, setTimeout: () => 0, clearTimeout: () => undefined, now: () => 0 },
  });
  c.start();
  await settle();
  c.setAddress(OWNER);
  c.submit();
  await settle();
  await settle();
  assert.equal(posts.at(-1)?.chainId, ARC_CHAIN_ID);
});

test('the other_chain line keeps the server message beyond the chain it names', () => {
  const server = 'This agent is already on another chain. An agent has one chain for now.';
  assert.equal(
    otherChainText({ chainId: 8453, name: 'Base' }, server),
    'This agent already lives on Base. An agent has one chain for now.',
  );
  assert.equal(
    otherChainText({ chainId: 8453 }, 'Ask support.'),
    'This agent already lives on Base. Ask support.',
  );
  assert.equal(otherChainText({ chainId: 5042 }, ''), 'This agent already lives on Arc.');
  assert.equal(otherChainText(undefined, undefined), 'This agent already lives on another chain.');
});

test('a chain chosen but not used yet can still be changed: nothing exists on it', () => {
  const free = { arcOn: true, identity: null, wallet: null };
  assert.equal(chainChangeShown({ ...free, chosen: BASE_MAINNET }), true);
  assert.equal(chainChangeShown({ ...free, chosen: ARC_CHAIN_ID }), true);
  assert.equal(chainChangeShown({ ...free, chosen: undefined }), false);
  assert.equal(chainChangeShown({ ...free, arcOn: false, chosen: BASE_MAINNET }), false);
  const started = { state: 'pending' as const, erc8004AgentId: null, agentUri: '' };
  assert.equal(chainChangeShown({ ...free, identity: started, chosen: ARC_CHAIN_ID }), false);
  assert.equal(
    chainChangeShown({ ...free, wallet: { address: OWNER }, chosen: ARC_CHAIN_ID }),
    false,
  );
});
