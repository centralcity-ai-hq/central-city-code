import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  finishedId,
  retryAllowed,
  stageOf,
  type IdentityView,
} from '../src/base/baseRegistrationModel';
import {
  FINALIZING_USUAL_MS,
  SLOW_AFTER_MS,
  baseIdOf,
  baseProfileOf,
  baseRowSummary,
  baseScreenState,
  finalizingLine,
  finalizingSince,
  isSlow,
  mayHaveBase,
  msUntilFinalizingLong,
  msUntilSlow,
  openRetryOffered,
  passportCode,
  publicForBase,
  type BaseScreenInput,
} from '../src/agents/v4/baseScreenModel';

const now = Date.parse('2026-10-10T08:00:00.000Z');

function identity(overrides: Partial<IdentityView> = {}): IdentityView {
  return {
    state: 'submitted',
    erc8004AgentId: null,
    agentUri: 'https://centralcity.ai/a/fjPsW7',
    ...overrides,
  };
}

function input(overrides: Partial<BaseScreenInput> = {}): BaseScreenInput {
  const base: BaseScreenInput = {
    loading: false,
    loadFailed: false,
    notAvailable: false,
    isPublic: true,
    hasProfile: true,
    confirmingPublic: false,
    madePublic: false,
    noProfile: false,
    identity: null,
    stage: null,
    busy: false,
    waitingSince: null,
    now,
  };
  const merged = { ...base, ...overrides };
  if (merged.identity && overrides.stage === undefined) merged.stage = stageOf(merged.identity);
  return merged;
}

test('loading, unreadable and unknown agents never offer to register', () => {
  assert.equal(baseScreenState(input({ loading: true })), 'loading');
  assert.equal(baseScreenState(input({ loadFailed: true })), 'error');
  // The server answers 404 for an agent without a manifest: not available, not an error.
  assert.equal(baseScreenState(input({ loadFailed: true, notAvailable: true })), 'unavailable');
  // A private agent without a profile cannot be made public.
  assert.equal(baseScreenState(input({ isPublic: false, hasProfile: false })), 'unavailable');
  assert.equal(
    baseScreenState(input({ isPublic: false, hasProfile: false, confirmingPublic: true })),
    'unavailable',
  );
});

test('no registration yet is the start screen; the first request shows Registering', () => {
  assert.equal(baseScreenState(input()), 'start');
  assert.equal(baseScreenState(input({ busy: true })), 'registering');
});

test('a private agent with a profile gets the start offer, then one question before anything', () => {
  const ask = input({ isPublic: false });
  assert.equal(baseScreenState(ask), 'start');
  assert.equal(baseScreenState({ ...ask, confirmingPublic: true }), 'confirm');
  // The question stays while the change is on its way, so its buttons can show they are busy.
  assert.equal(baseScreenState({ ...ask, confirmingPublic: true, busy: true }), 'confirm');
  // Made public here: the registration runs as for a public agent, even before the agent
  // itself reloads as public.
  const made = { ...ask, madePublic: true };
  assert.equal(baseScreenState({ ...made, busy: true }), 'registering');
  assert.equal(baseScreenState(made), 'start');
  assert.equal(baseScreenState({ ...made, confirmingPublic: true }), 'start');
  // A registration that then fails is the normal failed screen.
  const failed = identity({ state: 'failed', stage: 'failed', canRetry: true });
  assert.equal(baseScreenState({ ...made, identity: failed, stage: 'failed' }), 'failed');
  // The server says it has no profile after all: not available, the question is gone.
  assert.equal(baseScreenState({ ...ask, noProfile: true }), 'unavailable');
  assert.equal(baseScreenState({ ...ask, noProfile: true, confirmingPublic: true }), 'unavailable');
  // A public agent is never asked.
  assert.equal(baseScreenState(input({ confirmingPublic: true })), 'start');
});

test('the agent says whether it is public and whether it has a profile at all', () => {
  assert.deepEqual(baseProfileOf({ visibility: 'public', manifestHash: 'h', revision: 2 }), {
    isPublic: true,
    hasProfile: true,
  });
  assert.deepEqual(baseProfileOf({ visibility: 'private', manifestHash: 'h', revision: 1 }), {
    isPublic: false,
    hasProfile: true,
  });
  // Made from a manifest before its visibility was remembered: it has a profile.
  assert.deepEqual(baseProfileOf({ manifestHash: 'h' }), { isPublic: false, hasProfile: true });
  assert.deepEqual(baseProfileOf({ revision: 1 }), { isPublic: false, hasProfile: true });
  // Created without a manifest: no visibility, hash or revision.
  assert.deepEqual(baseProfileOf({}), { isPublic: false, hasProfile: false });
  assert.equal(publicForBase({ isPublic: false, madePublic: true }), true);
  assert.equal(publicForBase({ isPublic: false, madePublic: false }), false);
});

test('an agent without a profile is "Not available" at once, never loading', () => {
  // The server answers 404 for an agent without a manifest, so its status is never read.
  const none = baseProfileOf({});
  assert.equal(mayHaveBase(none), false);
  assert.equal(mayHaveBase(baseProfileOf({ visibility: 'private', revision: 1 })), true);
  assert.equal(mayHaveBase(baseProfileOf({ visibility: 'public', revision: 1 })), true);
  assert.equal(mayHaveBase(baseProfileOf({ manifestHash: 'h' })), true);
  // Its row and screen: "Not available" from the first render, whatever the (unread) status says.
  for (const status of [
    { loading: true },
    { loading: true, loadFailed: true },
    { loadFailed: true },
    {},
  ]) {
    const state = baseScreenState(input({ ...none, ...status }));
    assert.equal(state, 'unavailable', JSON.stringify(status));
    assert.equal(baseRowSummary(state, null).text, 'Not available');
  }
  // An agent with a profile, public or private, still waits for its status.
  assert.equal(baseScreenState(input({ loading: true })), 'loading');
  assert.equal(baseScreenState(input({ isPublic: false, loading: true })), 'loading');
});

test('registering and handing over both read as Registering until 60 s have passed', () => {
  for (const stage of ['registering', 'handing_over'] as const) {
    const id = identity({ stage });
    assert.equal(baseScreenState(input({ identity: id, waitingSince: now - 1000 })), 'registering');
    assert.equal(
      baseScreenState(input({ identity: id, waitingSince: now - SLOW_AFTER_MS })),
      'registering',
    );
    assert.equal(
      baseScreenState(input({ identity: id, waitingSince: now - SLOW_AFTER_MS - 1 })),
      'slow',
    );
  }
  // Older servers send no stage: a submitted registration without an ID is registering too.
  assert.equal(baseScreenState(input({ identity: identity() })), 'registering');
});

test('the slow threshold only applies while waiting for the Base ID', () => {
  const long = now - 10 * SLOW_AFTER_MS;
  assert.equal(isSlow('registering', long, now), true);
  assert.equal(isSlow('handing_over', long, now), true);
  for (const stage of ['registered', 'finalizing', 'rechecking', 'confirmed', 'failed'] as const)
    assert.equal(isSlow(stage, long, now), false, stage);
  assert.equal(isSlow('registering', null, now), false);
  assert.equal(isSlow(null, long, now), false);
});

test('msUntilSlow wakes the screen just after the threshold, and never once slow', () => {
  assert.equal(msUntilSlow('registering', now - 1000, now), SLOW_AFTER_MS - 1000 + 1);
  assert.equal(msUntilSlow('registering', now - SLOW_AFTER_MS - 5, now), null);
  assert.equal(msUntilSlow('finalizing', now, now), null);
  assert.equal(msUntilSlow('registering', null, now), null);
});

test('registered and finalizing show the Base ID while finalizing, never as confirmed', () => {
  for (const stage of ['registered', 'finalizing'] as const) {
    const provisional = identity({ stage, provisionalAgentId: '99179' });
    assert.equal(baseScreenState(input({ identity: provisional })), 'finalizing');
    assert.equal(baseIdOf(provisional, stage), '99179');
    // No ID at all yet: still registering.
    assert.equal(baseScreenState(input({ identity: identity({ stage }) })), 'registering');
  }
});

const USUAL = 'Finalizing on Base · usually 15–30 min';
const LONGER = 'Finalizing on Base · taking longer than usual';

test('the finalizing line says 15–30 min until 30 min have passed, then that it takes longer', () => {
  assert.equal(FINALIZING_USUAL_MS, 30 * 60_000);
  assert.equal(finalizingLine(now - 1000, now), USUAL);
  assert.equal(finalizingLine(now - 20 * 60_000, now), USUAL);
  // The boundary: exactly 30 min is still usual, a moment later it is not.
  assert.equal(finalizingLine(now - FINALIZING_USUAL_MS, now), USUAL);
  assert.equal(finalizingLine(now - FINALIZING_USUAL_MS - 1, now), LONGER);
  assert.equal(finalizingLine(now - 2 * FINALIZING_USUAL_MS, now), LONGER);
  // Without a time from the server it never claims to be late.
  assert.equal(finalizingLine(null, now), USUAL);
  // The home row's quiet line is the same line.
  assert.equal(baseRowSummary('finalizing', '1', now - 1000, now).sub, USUAL);
  assert.equal(baseRowSummary('finalizing', '1', now - FINALIZING_USUAL_MS, now).sub, USUAL);
  assert.equal(baseRowSummary('finalizing', '1', now - FINALIZING_USUAL_MS - 1, now).sub, LONGER);
  assert.equal(baseRowSummary('finalizing', '1').sub, USUAL);
});

test('finalizing is timed from when the Base ID was seen, else the start, and only while finalizing', () => {
  for (const stage of ['registered', 'finalizing'] as const) {
    const both = identity({ stage, provisionalAgentId: '7', idSeenAt: now - 1000, startedAt: 5 });
    assert.equal(finalizingSince(both, stage), now - 1000);
    assert.equal(finalizingSince(identity({ stage, startedAt: 5 }), stage), 5);
    assert.equal(finalizingSince(identity({ stage, idSeenAt: null, startedAt: 5 }), stage), 5);
    assert.equal(finalizingSince(identity({ stage }), stage), null);
    assert.equal(finalizingSince(identity({ stage, idSeenAt: Number.NaN }), stage), null);
  }
  const seen = identity({ idSeenAt: now - 1000, startedAt: 5 });
  for (const stage of ['registering', 'handing_over', 'rechecking', 'confirmed', 'failed'] as const)
    assert.equal(finalizingSince(seen, stage), null, stage);
  assert.equal(finalizingSince(null, 'finalizing'), null);
  assert.equal(finalizingSince(seen, null), null);
});

test('msUntilFinalizingLong wakes the line just after 30 min, and never once past it', () => {
  const seen = now - 1000;
  const wait = msUntilFinalizingLong(seen, now)!;
  assert.equal(wait, FINALIZING_USUAL_MS - 1000 + 1);
  assert.equal(finalizingLine(seen, now + wait - 1), USUAL);
  assert.equal(finalizingLine(seen, now + wait), LONGER);
  assert.equal(msUntilFinalizingLong(now - FINALIZING_USUAL_MS, now), 1);
  assert.equal(msUntilFinalizingLong(now - FINALIZING_USUAL_MS - 1, now), null);
  assert.equal(msUntilFinalizingLong(null, now), null);
});

test('only a confirmed registration is final', () => {
  const confirmed = identity({ state: 'confirmed', stage: 'confirmed', erc8004AgentId: '99179' });
  assert.equal(baseScreenState(input({ identity: confirmed })), 'final');
  assert.equal(baseIdOf(confirmed, 'confirmed'), '99179');
  // Older servers: state confirmed without a stage.
  const legacy = identity({ state: 'confirmed', erc8004AgentId: '1532' });
  assert.equal(baseScreenState(input({ identity: legacy })), 'final');
});

test('re-checking and failed are their own screens', () => {
  const recheck = identity({ stage: 'rechecking', provisionalAgentId: '7' });
  assert.equal(baseScreenState(input({ identity: recheck })), 'rechecking');
  // A provisional number is never shown while Base re-checks.
  assert.equal(finishedId(recheck, 'rechecking'), null);
  const failed = identity({ state: 'failed', stage: 'failed', canRetry: false });
  assert.equal(baseScreenState(input({ identity: failed })), 'failed');
  assert.equal(retryAllowed(failed, 'failed'), false);
  assert.equal(retryAllowed({ ...failed, canRetry: true }, 'failed'), true);
});

test('an open registration offers a new attempt only when the server says it takes one', () => {
  const open = identity({ stage: 'registering' });
  assert.equal(openRetryOffered(open, 'registering'), false);
  // Stuck before minting (or a lost mint): the server's canRetry.
  assert.equal(openRetryOffered({ ...open, canRetry: true }, 'registering'), true);
  assert.equal(openRetryOffered({ ...open, canRetry: true }, 'handing_over'), true);
  assert.equal(openRetryOffered({ ...open, canRetry: true }, 'rechecking'), true);
  // An older server without canRetry: none while open, though retryAllowed guesses one.
  const older = identity({ state: 'submitted' });
  assert.equal(retryAllowed(older, 'registering'), true);
  assert.equal(openRetryOffered(older, 'registering'), false);
  // A failed registration has its own screen and Try again; nothing before the status is read.
  assert.equal(openRetryOffered({ ...open, canRetry: true }, 'failed'), false);
  assert.equal(openRetryOffered(null, null), false);
});

test('the home row says what the mockup says for every state', () => {
  const text = (state: Parameters<typeof baseRowSummary>[0], id: string | null = null) =>
    baseRowSummary(state, id);
  assert.deepEqual(text('start'), {
    text: 'Not yet',
    tone: 'muted',
    spinner: false,
    check: false,
    sub: null,
  });
  assert.deepEqual(text('confirm'), text('start'));
  assert.equal(text('registering').text, 'Registering');
  assert.equal(text('registering').spinner, true);
  assert.equal(text('slow').text, 'Taking longer');
  const finalizing = text('finalizing', '99179');
  assert.equal(finalizing.text, 'ID 99179');
  assert.equal(finalizing.tone, 'strong');
  assert.equal(finalizing.check, false);
  assert.equal(finalizing.sub, USUAL);
  const final = text('final', '99179');
  assert.equal(final.text, 'ID 99179');
  assert.equal(final.check, true);
  assert.equal(final.sub, null);
  assert.equal(text('rechecking').text, 'Re-checking');
  assert.equal(text('rechecking').spinner, true);
  assert.equal(text('failed').text, 'Didn’t go through');
  assert.equal(text('failed').tone, 'bad');
  assert.equal(text('unavailable').text, 'Not available');
  assert.equal(text('loading').text, null);
  assert.equal(text('error').text, null);
});

test('the check mark shows for the final state only', () => {
  for (const state of [
    'loading',
    'error',
    'unavailable',
    'start',
    'confirm',
    'registering',
    'slow',
    'finalizing',
    'rechecking',
    'failed',
  ] as const)
    assert.equal(baseRowSummary(state, '1').check, false, state);
});

test('the passport code is the last part of the agent address', () => {
  assert.equal(passportCode('https://centralcity.ai/a/fjPsW7'), 'fjPsW7');
  assert.equal(passportCode('https://centralcity.ai/a/fjPsW7/'), 'fjPsW7');
  assert.equal(passportCode('https://centralcity.ai/a/fjPsW7?x=1'), 'fjPsW7');
});
