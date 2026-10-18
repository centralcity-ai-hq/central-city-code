import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api.js';
import {
  addFeedText,
  agentPayFailure,
  agentPayPanel,
  AgentPayReadError,
  agentPayViewFrom,
  allowAgentPay,
  boundsText,
  changedText,
  consentRequest,
  feedLine,
  givenAt,
  notStoredText,
  readAgentPay,
  recheckAllow,
  recipientLines,
  refusedForSure,
  statusText,
  stores,
  unsureText,
  withdrawAgentPay,
  withdrawPrompt,
  withoutTryAgain,
  type AgentPayRecipients,
  type AgentPayView,
  type ShownLimit,
} from '../src/base/wallet/agentPay.js';
import { hasMachineText } from '../src/ui/plainText.js';

/*
 * The owner's permission for an agent to pay on its own, in the browser (src/base/wallet/agentPay.ts;
 * server: server/base/wallet/agent-pay-consent.ts): what a confirm sends (exactly the view's limit
 * and confirmRecipients), what the section shows next to the limit card, its words, and the three
 * requests against a fake fetch (no network).
 */

const AGENT = '11111111-1111-4111-8111-111111111111';
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const PATH = `/api/base/agents/${AGENT}/wallet/agent-pay`;
// Thursday 15 Oct 2026, 14:02 in Berlin (CEST).
const GRANTED = Date.UTC(2026, 9, 15, 12, 2, 0);
const AGENTS: AgentPayRecipients = 'central-city-agents';
const FEED: AgentPayRecipients = 'central-city-agents-and-feed-services';
const ACTIVE: ShownLimit = { permissionHash: HASH, state: 'approved' };

/** A view as the server answers it; `offer` is what confirming now stores. */
function view(
  options: {
    offer?: AgentPayRecipients;
    consent?: { recipients: AgentPayRecipients; hash?: string; covers?: boolean } | null;
    limit?: string | null;
  } = {},
): AgentPayView {
  const offer = options.offer ?? AGENTS;
  const limit = options.limit === undefined ? HASH : options.limit;
  const c = options.consent ?? null;
  const covers = !!(c && limit && (c.covers ?? true));
  // As the server: what a covering consent allows now is the narrower of stored and offered.
  const allowed =
    covers && c ? (c.recipients === AGENTS || offer === AGENTS ? AGENTS : FEED) : null;
  return {
    chainId: 84532,
    token: 'USDC',
    scope: {
      recipients: allowed ?? offer,
      token: 'USDC',
      withinLimit: limit
        ? { permissionHash: limit, period: 'day', capRaw: '20000000', capDisplay: '20' }
        : null,
    },
    consent: c
      ? {
          permissionHash: c.hash ?? (covers ? (limit ?? HASH) : OTHER_HASH),
          recipients: c.recipients,
          grantedAt: GRANTED,
          coversCurrentLimit: covers,
        }
      : null,
    mayPay: covers,
    confirmRecipients: offer,
    reconfirmAddsFeedServices: allowed === AGENTS && offer === FEED,
  };
}

const shown = (panel: ReturnType<typeof agentPayPanel>) => {
  assert.equal(panel.k, 'shown');
  return panel as Extract<typeof panel, { k: 'shown' }>;
};

test('a view is read only when it is one: known recipients, a limit hash, a well-formed consent', () => {
  for (const good of [
    view(),
    view({ offer: FEED }),
    view({ consent: { recipients: AGENTS } }),
    view({ limit: null }),
  ])
    assert.deepEqual(agentPayViewFrom(JSON.parse(JSON.stringify(good))), good);
  const v = view({ consent: { recipients: AGENTS } });
  for (const bad of [
    null,
    'yes',
    { ...v, scope: undefined },
    { ...v, confirmRecipients: 'everyone' },
    { ...v, scope: { ...v.scope, recipients: 'feed-services' } },
    { ...v, scope: { ...v.scope, withinLimit: { permissionHash: '0x12' } } },
    { ...v, scope: { ...v.scope, withinLimit: {} } },
    { ...v, mayPay: 'true' },
    { ...v, reconfirmAddsFeedServices: undefined },
    { ...v, consent: { ...v.consent, recipients: 'anyone' } },
    { ...v, consent: { ...v.consent, grantedAt: 'today' } },
    { ...v, consent: { ...v.consent, coversCurrentLimit: 1 } },
  ])
    assert.equal(agentPayViewFrom(bad), null, JSON.stringify(bad));
});

test('a confirm sends the limit on screen and confirmRecipients exactly as read, never wider', () => {
  // Read while Feed pay was off: Central City agents only, whatever the server offers by now.
  assert.deepEqual(consentRequest(view()), { permissionHash: HASH, recipients: AGENTS });
  assert.deepEqual(consentRequest(view({ offer: FEED })), {
    permissionHash: HASH,
    recipients: FEED,
  });
  // Allowed for agents only while Feed services are offered: the re-confirm sends the wider one
  // the view offers, not what the live permission allows.
  const reconfirm = view({ offer: FEED, consent: { recipients: AGENTS } });
  assert.equal(reconfirm.scope.recipients, AGENTS);
  assert.deepEqual(consentRequest(reconfirm), { permissionHash: HASH, recipients: FEED });
  // No limit in the view: nothing to send.
  assert.equal(consentRequest(view({ limit: null })), null);
});

test('the section shows only next to an active limit, and only for the limit on the card', () => {
  assert.deepEqual(agentPayPanel(view(), null), { k: 'hidden' });
  for (const state of ['revoke_pending', 'revoked'] as const)
    assert.deepEqual(agentPayPanel(view(), { permissionHash: HASH, state }), { k: 'hidden' });
  // The view is about another limit than the card, or has none while the card shows one (revoked
  // or replaced meanwhile): read both again, offer nothing.
  assert.deepEqual(agentPayPanel(view({ limit: OTHER_HASH }), ACTIVE), { k: 'mismatch' });
  assert.deepEqual(agentPayPanel(view({ limit: null }), ACTIVE), { k: 'mismatch' });
  // The same hash in another case is the same limit.
  assert.equal(
    agentPayPanel(view(), {
      permissionHash: HASH.toUpperCase().replace('0X', '0x'),
      state: 'signed',
    }).k,
    'shown',
  );
});

test('not allowed yet: what confirming now allows, and whether an earlier limit had it', () => {
  const none = shown(agentPayPanel(view(), ACTIVE));
  assert.deepEqual(none, {
    k: 'shown',
    allowed: false,
    grantedAt: null,
    earlierAt: null,
    recipients: AGENTS,
    addsFeed: false,
    feedOff: false,
  });
  assert.equal(statusText(none, 'Scout'), 'Not allowed. Scout can’t pay on its own.');
  // Offered with Feed services: the list says so before the owner confirms.
  assert.equal(shown(agentPayPanel(view({ offer: FEED }), ACTIVE)).recipients, FEED);
  // Given for an earlier limit: not allowed for this one, and the screen says when it was given.
  const earlier = shown(
    agentPayPanel(view({ offer: FEED, consent: { recipients: FEED, covers: false } }), ACTIVE),
  );
  assert.equal(earlier.allowed, false);
  assert.equal(earlier.earlierAt, GRANTED);
  assert.equal(earlier.recipients, FEED);
  assert.equal(
    statusText(earlier, 'Scout'),
    'Not allowed for this limit. You allowed it on Thu 15 Oct 2026, 14:02 (Berlin time) for an earlier limit; a new limit needs your OK again.',
  );
});

test('allowed: since when, what it allows now (never wider than stored), and the Feed re-confirm', () => {
  const agentsOnly = shown(agentPayPanel(view({ consent: { recipients: AGENTS } }), ACTIVE));
  assert.equal(agentsOnly.allowed, true);
  assert.equal(agentsOnly.grantedAt, GRANTED);
  assert.equal(agentsOnly.addsFeed, false);
  assert.equal(
    statusText(agentsOnly, 'Scout'),
    'Allowed since Thu 15 Oct 2026, 14:02 (Berlin time).',
  );
  // Feed pay on now: confirming again adds Feed services; until then the list is agents only.
  const offered = shown(
    agentPayPanel(view({ offer: FEED, consent: { recipients: AGENTS } }), ACTIVE),
  );
  assert.equal(offered.recipients, AGENTS);
  assert.equal(offered.addsFeed, true);
  // Confirmed with Feed services, Feed pay off now: agents only, and the screen says why.
  const paused = shown(
    agentPayPanel(view({ offer: AGENTS, consent: { recipients: FEED } }), ACTIVE),
  );
  assert.equal(paused.recipients, AGENTS);
  assert.equal(paused.feedOff, true);
  assert.equal(paused.addsFeed, false);
  const both = shown(agentPayPanel(view({ offer: FEED, consent: { recipients: FEED } }), ACTIVE));
  assert.equal(both.recipients, FEED);
  assert.equal(both.feedOff, false);
  assert.equal(both.addsFeed, false);
  // The server says it may not pay: never shown as allowed, whatever the consent row says.
  const refused = { ...view({ consent: { recipients: AGENTS } }), mayPay: false };
  assert.equal(shown(agentPayPanel(refused, ACTIVE)).allowed, false);
  // A consent for another hash than the limit: not allowed.
  const elsewhere = view({ consent: { recipients: AGENTS, hash: OTHER_HASH } });
  assert.equal(shown(agentPayPanel(elsewhere, ACTIVE)).allowed, false);
});

test('the words: whom it may pay, the fee and the per-call maximum, the limit; no internal names', () => {
  assert.deepEqual(recipientLines(AGENTS, 'Scout'), ['Other Central City agents.']);
  const lines = recipientLines(FEED, 'Scout');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], feedLine('Scout'));
  // The fee comes on top for outside services and is part of the price for Central City's own.
  assert.match(
    lines[1]!,
    /^Services listed in the Feed\. Central City’s 10% fee comes on top of the price for outside services and is included in the price for services sold by Central City agents\. One call/,
  );
  assert.doesNotMatch(lines[1]!, /on top of each price/);
  assert.match(
    lines[1]!,
    /Scout’s per-call maximum \(0\.10 USDC unless you set a lower one\), fee included\.$/,
  );
  assert.match(addFeedText('Scout'), /doesn’t pay services listed in the Feed on its own yet/);
  assert.match(addFeedText('Scout'), /10% fee comes on top of the price for outside services/);
  assert.match(addFeedText('Scout'), /included in the price for services sold by Central City/);
  assert.equal(
    boundsText('Scout', '20.00 USDC a day'),
    'Only within the limit you signed: 20.00 USDC a day. Scout pays without asking you each time, and payments can’t be undone. You can withdraw this at any time.',
  );
  assert.match(withdrawPrompt('Scout'), /^Scout stops paying on its own at once\./);
  assert.match(
    changedText('scope', 'Scout'),
    /^What Scout may pay changed while this page was open/,
  );
  assert.match(changedText('limit', 'Scout'), /^The spending limit changed/);
  // With the year (a permission can be a year old), in Berlin whatever the machine's zone.
  assert.equal(givenAt(GRANTED), 'Thu 15 Oct 2026, 14:02');
  assert.equal(givenAt(Date.UTC(2025, 11, 31, 23, 30)), 'Thu 1 Jan 2026, 00:30');
  const all = [
    ...lines,
    addFeedText('Scout'),
    boundsText('Scout', '20.00 USDC a day'),
    withdrawPrompt('Scout'),
    changedText('scope', 'Scout'),
    changedText('scope', 'Scout', true, view()),
    changedText('limit', 'Scout'),
    statusText(shown(agentPayPanel(view(), ACTIVE)), 'Scout'),
    notStoredText(new ApiError('The wallet is paused.', 409, 'wallet_not_usable'), true, false),
    notStoredText(new TypeError('Failed to fetch'), false, true),
    unsureText('Scout', false),
    unsureText('Scout', true),
  ];
  for (const text of all) {
    assert.equal(hasMachineText(text), false, text);
    assert.doesNotMatch(
      text,
      /central-city-agents|feed-services|services:pay|consent|scope|permissionHash|recipients|city_|x402|P2b/i,
      text,
    );
  }
  assert.equal(
    agentPayFailure(new ApiError('The wallet is paused.', 409)),
    'The wallet is paused.',
  );
  assert.equal(
    agentPayFailure(new TypeError('Failed to fetch')),
    'Something went wrong. Try again.',
  );
});

/** A fake fetch: answers in order, records every request. */
function fakeFetch(answers: Array<{ status?: number; json: unknown }>) {
  const requests: Array<{
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected request');
    return Response.json(answer.json, { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = original) };
}

test('read: the view, off on 404, an error otherwise; an answer that is no view is refused', async () => {
  const fake = fakeFetch([
    { json: view() },
    { status: 404, json: { error: 'Not found.' } },
    { status: 500, json: { error: 'Something broke on our side.' } },
    { json: { ...view(), confirmRecipients: 'everyone' } },
  ]);
  try {
    assert.deepEqual(await readAgentPay(AGENT), { kind: 'view', view: view() });
    assert.deepEqual(await readAgentPay(AGENT), { kind: 'off' });
    await assert.rejects(readAgentPay(AGENT), ApiError);
    await assert.rejects(readAgentPay(AGENT), AgentPayReadError);
    assert.deepEqual(
      fake.requests.map((request) => [request.method, request.url, request.body]),
      Array(4).fill(['GET', PATH, undefined]),
    );
  } finally {
    fake.restore();
  }
});

test('allow: one PUT with the view’s limit and confirmRecipients; it answers the new view', async () => {
  const after = view({ consent: { recipients: AGENTS } });
  const fake = fakeFetch([{ json: after }]);
  try {
    // A view read while Feed pay was off: Central City agents only is what goes.
    const result = await allowAgentPay(AGENT, view());
    assert.deepEqual(result, { kind: 'allowed', view: after });
    assert.equal(fake.requests.length, 1);
    const [put] = fake.requests;
    assert.equal(put!.method, 'PUT');
    assert.equal(put!.url, PATH);
    assert.equal(put!.headers['X-City-Request'], '1');
    assert.deepEqual(put!.body, { permissionHash: HASH, recipients: AGENTS });
  } finally {
    fake.restore();
  }
});

test('also allow Feed services: the same PUT with the wider confirmRecipients the view offers', async () => {
  const before = view({ offer: FEED, consent: { recipients: AGENTS } });
  const after = view({ offer: FEED, consent: { recipients: FEED } });
  const fake = fakeFetch([{ json: after }]);
  try {
    assert.deepEqual(await allowAgentPay(AGENT, before), { kind: 'allowed', view: after });
    assert.deepEqual(fake.requests[0]!.body, { permissionHash: HASH, recipients: FEED });
    assert.equal(shown(agentPayPanel(after, ACTIVE)).recipients, FEED);
  } finally {
    fake.restore();
  }
});

test('"Also allow Feed services" refused (409 scope_changed): the message matches the view read again', async () => {
  const CHANGED =
    'What Scout may pay changed while this page was open, so nothing was saved. Check it again, then confirm.';
  const CANT_ADD = 'Feed services can’t be added right now, so nothing was changed.';
  const before = view({ offer: FEED, consent: { recipients: AGENTS } });
  assert.equal(shown(agentPayPanel(before, ACTIVE)).addsFeed, true);
  // Paying Feed services went off meanwhile: read again, the view no longer offers them.
  const agentsOnly = view({ offer: AGENTS, consent: { recipients: AGENTS } });
  const fake = fakeFetch([
    {
      status: 409,
      json: {
        error:
          'Paying services in the Feed is off now. Look at what the agent may pay again before you allow payments.',
        code: 'scope_changed',
      },
    },
    { json: agentsOnly },
  ]);
  try {
    const result = await allowAgentPay(AGENT, before);
    assert.deepEqual(result, { kind: 'changed', change: 'scope', view: agentsOnly });
    assert.deepEqual(fake.requests[0]!.body, { permissionHash: HASH, recipients: FEED });
    // Nothing on screen to check and confirm again: the page says so plainly.
    assert.equal(shown(agentPayPanel(agentsOnly, ACTIVE)).addsFeed, false);
    assert.equal(
      result.kind === 'changed' && changedText(result.change, 'Scout', true, result.view),
      CANT_ADD,
    );
  } finally {
    fake.restore();
  }
  assert.equal(changedText('scope', 'Scout', true, null), CANT_ADD);
  // The view read again still offers Feed services: check it again, then confirm.
  assert.equal(shown(agentPayPanel(before, ACTIVE)).addsFeed, true);
  assert.equal(changedText('scope', 'Scout', true, before), CHANGED);
  // "Allow these payments" refused: the narrower terms are on screen to confirm, as before.
  assert.equal(changedText('scope', 'Scout', false, agentsOnly), CHANGED);
  assert.equal(changedText('scope', 'Scout'), CHANGED);
  // Another limit needs a new confirm either way.
  assert.equal(
    changedText('limit', 'Scout', true, agentsOnly),
    'The spending limit changed, so nothing was saved. Check it again, then confirm.',
  );
});

test('409 scope_changed or limit_changed: nothing stored, the view is read again and answered', async () => {
  const narrower = view({ offer: AGENTS });
  const fake = fakeFetch([
    {
      status: 409,
      json: {
        error:
          'Paying services in the Feed is off now. Look at what the agent may pay again before you allow payments.',
        code: 'scope_changed',
      },
    },
    { json: narrower },
    {
      status: 409,
      json: {
        error: 'The spending limit changed. Look at it again before you allow payments.',
        code: 'limit_changed',
      },
    },
    { json: view({ limit: OTHER_HASH }) },
    { status: 409, json: { error: 'Set a spending limit first.', code: 'no_spending_limit' } },
    { status: 404, json: { error: 'Not found.' } },
  ]);
  try {
    assert.deepEqual(await allowAgentPay(AGENT, view({ offer: FEED })), {
      kind: 'changed',
      change: 'scope',
      view: narrower,
    });
    // The re-read view offers agents only: that is what the next confirm sends.
    assert.deepEqual(consentRequest(narrower), { permissionHash: HASH, recipients: AGENTS });
    const limit = await allowAgentPay(AGENT, view());
    assert.equal(limit.kind, 'changed');
    assert.equal(limit.kind === 'changed' && limit.change, 'limit');
    assert.equal(limit.kind === 'changed' && agentPayPanel(limit.view!, ACTIVE).k, 'mismatch');
    assert.deepEqual(await allowAgentPay(AGENT, view()), {
      kind: 'changed',
      change: 'limit',
      view: null,
    });
    assert.deepEqual(
      fake.requests.map((request) => request.method),
      ['PUT', 'GET', 'PUT', 'GET', 'PUT', 'GET'],
    );
    assert.deepEqual(fake.requests[0]!.body, { permissionHash: HASH, recipients: FEED });
  } finally {
    fake.restore();
  }
});

test('allow: any other refusal is an error, read nothing again; a view without a limit sends nothing', async () => {
  const fake = fakeFetch([
    { status: 409, json: { error: 'The wallet is paused.', code: 'wallet_not_usable' } },
    { status: 400, json: { error: 'Send the limit you consent to.', code: 'invalid_body' } },
    { json: view({ limit: null }) },
  ]);
  try {
    await assert.rejects(allowAgentPay(AGENT, view()), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'wallet_not_usable');
      return true;
    });
    await assert.rejects(allowAgentPay(AGENT, view()), ApiError);
    assert.deepEqual(await allowAgentPay(AGENT, view({ limit: null })), {
      kind: 'changed',
      change: 'limit',
      view: view({ limit: null }),
    });
    assert.deepEqual(
      fake.requests.map((request) => request.method),
      ['PUT', 'PUT', 'GET'],
    );
  } finally {
    fake.restore();
  }
});

test('409 scope_changed while the limit changed too: the change is the limit, read again for it', async () => {
  const fake = fakeFetch([
    {
      status: 409,
      json: {
        error:
          'Paying services in the Feed is off now. Look at what the agent may pay again before you allow payments.',
        code: 'scope_changed',
      },
    },
    { json: view({ limit: OTHER_HASH }) },
    {
      status: 409,
      json: { error: 'Paying services in the Feed is off now.', code: 'scope_changed' },
    },
    { json: view({ limit: null }) },
  ]);
  try {
    // The server checks whom it covers first; the view read again is for another limit.
    assert.deepEqual(await allowAgentPay(AGENT, view({ offer: FEED })), {
      kind: 'changed',
      change: 'limit',
      view: view({ limit: OTHER_HASH }),
    });
    // No active limit any more: the limit changed as well.
    assert.deepEqual(await allowAgentPay(AGENT, view({ offer: FEED })), {
      kind: 'changed',
      change: 'limit',
      view: view({ limit: null }),
    });
  } finally {
    fake.restore();
  }
  // The words match: the limit changed, not only whom it may pay.
  assert.match(
    changedText('limit', 'Scout', true, view({ limit: OTHER_HASH })),
    /^The spending limit changed/,
  );
});

test('a refusal is sure (4xx: nothing stored); anything else may have been stored', () => {
  for (const status of [400, 403, 404, 409, 429])
    assert.equal(refusedForSure(new ApiError('No.', status)), true, String(status));
  for (const error of [
    new ApiError('Something broke on our side.', 500),
    new ApiError('Busy.', 503),
    new ApiError('Timed out.', 504),
    new ApiError('Timed out.', 408),
    new TypeError('Failed to fetch'),
    new AgentPayReadError(),
  ])
    assert.equal(refusedForSure(error), false, String(error));
  // Stored is exactly what was sent, for the limit it covers now.
  const sent = { permissionHash: HASH, recipients: FEED };
  assert.equal(stores(view({ offer: FEED, consent: { recipients: FEED } }), sent), true);
  assert.equal(
    stores(view({ offer: FEED, consent: { recipients: FEED } }), {
      ...sent,
      permissionHash: HASH.toUpperCase().replace('0X', '0x'),
    }),
    true,
  );
  assert.equal(stores(view({ offer: FEED, consent: { recipients: AGENTS } }), sent), false);
  assert.equal(stores(view({ offer: FEED }), sent), false);
  assert.equal(
    stores(view({ offer: FEED, consent: { recipients: FEED, covers: false } }), sent),
    false,
  );
});

test('a confirm with no clear answer is read again: stored, not stored, or plainly unknown', async () => {
  const lost = new ApiError('Something broke on our side.', 500);
  const allowed = view({ consent: { recipients: AGENTS } });
  const fake = fakeFetch([
    // The PUT committed, then its answer was lost: the view read again shows it stored.
    { json: allowed },
    // Not stored, as the view read again says.
    { json: view() },
    // Not read again either: unknown.
    { status: 503, json: { error: 'The database is busy.' } },
    { status: 404, json: { error: 'Not found.' } },
    // A refusal: nothing stored, read again or not.
    { json: view() },
    { status: 503, json: { error: 'The database is busy.' } },
    // "Also allow Feed services" lost: the permission for agents only is still what is stored.
    { json: view({ offer: FEED, consent: { recipients: AGENTS } }) },
  ]);
  try {
    assert.deepEqual(await recheckAllow(AGENT, view(), lost), { kind: 'stored', view: allowed });
    assert.deepEqual(await recheckAllow(AGENT, view(), new TypeError('Failed to fetch')), {
      kind: 'not-stored',
      sure: false,
      view: view(),
    });
    assert.deepEqual(await recheckAllow(AGENT, view(), lost), { kind: 'unknown' });
    assert.deepEqual(await recheckAllow(AGENT, view(), new AgentPayReadError()), {
      kind: 'unknown',
    });
    const paused = new ApiError('The wallet is paused.', 409, 'wallet_not_usable');
    assert.deepEqual(await recheckAllow(AGENT, view(), paused), {
      kind: 'not-stored',
      sure: true,
      view: view(),
    });
    assert.deepEqual(await recheckAllow(AGENT, view(), paused), {
      kind: 'not-stored',
      sure: true,
      view: null,
    });
    const before = view({ offer: FEED, consent: { recipients: AGENTS } });
    assert.deepEqual(await recheckAllow(AGENT, before, lost), {
      kind: 'not-stored',
      sure: false,
      view: before,
    });
    assert.deepEqual(
      fake.requests.map((request) => request.method),
      Array(7).fill('GET'),
    );
  } finally {
    fake.restore();
  }
  // In words: why, and that nothing was saved; or plainly that it can't be told.
  assert.equal(
    notStoredText(new ApiError('The wallet is paused.', 409), true, false),
    'The wallet is paused. Nothing was saved.',
  );
  assert.equal(
    notStoredText(new TypeError('Failed to fetch'), true, true),
    'Something went wrong. Nothing was changed.',
  );
  assert.equal(
    notStoredText(lost, false, false),
    'No clear answer came back, so this page read it again: nothing was saved.',
  );
  assert.equal(
    unsureText('Scout', false),
    'No clear answer came back, so this page can’t tell whether Scout may now pay on its own.',
  );
  assert.match(unsureText('Scout', true), /may now also pay services listed in the Feed\.$/);
  // A line with its own Try again button doesn't say it twice.
  assert.equal(
    withoutTryAgain('This page couldn’t read the answer. Try again.'),
    'This page couldn’t read the answer.',
  );
  assert.equal(
    withoutTryAgain('Too many requests. Try again in a minute.'),
    'Too many requests. Try again in a minute.',
  );
});

test('withdraw: one DELETE through the request guard; it answers the view after it', async () => {
  const fake = fakeFetch([{ json: view() }, { status: 404, json: { error: 'Not found.' } }]);
  try {
    const after = await withdrawAgentPay(AGENT);
    assert.deepEqual(after, view());
    assert.equal(shown(agentPayPanel(after, ACTIVE)).allowed, false);
    await assert.rejects(withdrawAgentPay(AGENT), ApiError);
    const [request] = fake.requests;
    assert.equal(request!.method, 'DELETE');
    assert.equal(request!.url, PATH);
    assert.equal(request!.headers['X-City-Request'], '1');
    assert.deepEqual(request!.body, {});
  } finally {
    fake.restore();
  }
});

test('against the real routes: the client reads every view the server builds and sends what it showed', async (t) => {
  // The server's service and routes on an in-memory database; requests go through app.inject.
  const { PGlite } = await import('@electric-sql/pglite');
  const { default: Fastify } = await import('fastify');
  const schema = await import('../server/base/schema.js');
  const { createAgentPayConsentService } =
    await import('../server/base/wallet/agent-pay-consent.js');
  const { registerAgentPayRoutes } = await import('../server/base/wallet/agent-pay-routes.js');
  const { BASE_NETWORKS } = await import('../shared/base/chains.js');
  const { WALLET_CHAIN_ID } = await import('../shared/base/wallet-network.js');
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner');`);
  for (const sql of [
    schema.BASE_MIGRATION_SQL,
    schema.BASE_PAYMENTS_MIGRATION_SQL,
    schema.BASE_WALLET_VAULT_SQL,
    schema.BASE_WALLET_LIMITS_SQL,
    schema.BASE_AGENT_PAY_CONSENTS_SQL,
    schema.BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL,
  ])
    await pg.exec(sql);
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at, owner_account_id)
     VALUES ('w-1',$1,'person-1',${WALLET_CHAIN_ID},$2,$3,$4,'v1:k','{}','derived',0,0,'person-1')`,
    [AGENT, `0x${'1'.repeat(40)}`, `0x${'e'.repeat(40)}`, `0x${'f'.repeat(40)}`],
  );
  await pg.query(
    `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature,
       state, token, permission_hash, period_kind, cap_raw, onchain_model, created_at, updated_at)
     VALUES ('p-a','w-1',${WALLET_CHAIN_ID},'{}','\\x00','onchain',$1,$2,'day',20000000,'half',0,0)`,
    [BASE_NETWORKS[WALLET_CHAIN_ID].tokens.USDC.address.toLowerCase(), HASH],
  );
  const env: Record<string, string | undefined> = { CITY_FEED_PAY: '0' };
  let clock = GRANTED;
  const app = Fastify();
  t.after(() => app.close());
  registerAgentPayRoutes(app, {
    enabled: () => true,
    person: async () => ({ ok: true, accountId: 'person-1' }),
    service: createAgentPayConsentService({
      db: {
        query: (sql, params) => pg.query(sql, params) as never,
        exec: (sql) => pg.exec(sql),
        transaction: (action) => pg.transaction((tx) => action(tx as never)),
        close: () => pg.close(),
      },
      chainId: WALLET_CHAIN_ID,
      now: () => (clock += 60_000),
      env,
    }),
  });
  const sent: Array<{ method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET') as 'GET' | 'PUT' | 'DELETE';
    sent.push({
      method,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = await app.inject({
      method,
      url: String(url),
      headers: init.headers as Record<string, string>,
      ...(init.body === undefined ? {} : { payload: String(init.body) }),
    });
    return new Response(answer.body, {
      status: answer.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const limit: ShownLimit = { permissionHash: HASH, state: 'approved' };
  const read = async () => {
    const answer = await readAgentPay(AGENT);
    assert.equal(answer.kind, 'view');
    return (answer as { view: AgentPayView }).view;
  };

  // Feed pay off: not allowed, agents only; confirming stores exactly that.
  const first = await read();
  assert.deepEqual(shown(agentPayPanel(first, limit)), {
    k: 'shown',
    allowed: false,
    grantedAt: null,
    earlierAt: null,
    recipients: AGENTS,
    addsFeed: false,
    feedOff: false,
  });
  const allowed = await allowAgentPay(AGENT, first);
  assert.equal(allowed.kind, 'allowed');
  const agentsOnly = shown(agentPayPanel((allowed as { view: AgentPayView }).view, limit));
  assert.equal(agentsOnly.allowed, true);
  assert.equal(agentsOnly.recipients, AGENTS);
  assert.equal(typeof agentsOnly.grantedAt, 'number');

  // Feed pay on: the same permission, and "Also allow Feed services" is offered and stores them.
  env.CITY_FEED_PAY = undefined;
  const offered = await read();
  assert.equal(shown(agentPayPanel(offered, limit)).addsFeed, true);
  const wide = await allowAgentPay(AGENT, offered);
  assert.equal(wide.kind, 'allowed');
  assert.equal(shown(agentPayPanel((wide as { view: AgentPayView }).view, limit)).recipients, FEED);

  // Withdrawn, then a tab read while Feed pay was on confirms after it went off: refused, read
  // again, and the narrower terms are what the next confirm stores.
  const after = await withdrawAgentPay(AGENT);
  assert.equal(shown(agentPayPanel(after, limit)).allowed, false);
  const stale = await read();
  assert.equal(stale.confirmRecipients, FEED);
  env.CITY_FEED_PAY = '0';
  const changed = await allowAgentPay(AGENT, stale);
  assert.equal(changed.kind, 'changed');
  assert.equal(changed.kind === 'changed' && changed.change, 'scope');
  const again = (changed as { view: AgentPayView }).view;
  assert.equal(shown(agentPayPanel(again, limit)).recipients, AGENTS);
  const narrow = await allowAgentPay(AGENT, again);
  assert.equal(narrow.kind, 'allowed');
  assert.equal(
    shown(agentPayPanel((narrow as { view: AgentPayView }).view, limit)).recipients,
    AGENTS,
  );
  assert.deepEqual(
    sent.filter((request) => request.method !== 'GET'),
    [
      { method: 'PUT', body: { permissionHash: HASH, recipients: AGENTS } },
      { method: 'PUT', body: { permissionHash: HASH, recipients: FEED } },
      { method: 'DELETE', body: {} },
      { method: 'PUT', body: { permissionHash: HASH, recipients: FEED } },
      { method: 'PUT', body: { permissionHash: HASH, recipients: AGENTS } },
    ],
  );
});
