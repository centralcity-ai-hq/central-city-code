import test from 'node:test';
import assert from 'node:assert/strict';
import { TestRoot, button, elements, text } from './helpers/hook-render.js';

const globals = globalThis as unknown as { window?: unknown };
globals.window ??= {
  location: { search: '', pathname: '/signin', hash: '' },
  history: { state: null, replaceState: () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { GoogleSignInOption, GoogleButton, GoogleLinkCheckFailed, useGoogleLink } =
  await import('../src/GoogleAccount.js');

/*
 * GET /api/auth/google failing (network, 429, 5xx) is not "Google sign-in is off": sign-in still
 * offers Continue with Google (the /start POST reports a real refusal), and Settings says the
 * check failed with Try again instead of "isn't available on this server".
 */

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeFetch(answer: () => Response) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string) => {
    calls.push(String(path));
    return answer();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test('a failed Google check still shows Continue with Google on sign-in', async () => {
  const fake = fakeFetch(() => respond(503, { error: 'Something went wrong' }));
  try {
    const root = new TestRoot(GoogleSignInOption, { register: false });
    await root.flush();
    assert.equal(fake.calls.length, 1);
    assert.ok(
      elements(root.output).some((element) => element.type === GoogleButton),
      'the Google button is drawn',
    );
    root.unmount();
  } finally {
    fake.restore();
  }
});

test('Google sign-in reported off hides the button', async () => {
  const fake = fakeFetch(() => respond(200, { enabled: false, linked: null }));
  try {
    const root = new TestRoot(GoogleSignInOption, { register: false });
    await root.flush();
    assert.equal(
      elements(root.output).some((element) => element.type === GoogleButton),
      false,
    );
    root.unmount();
  } finally {
    fake.restore();
  }
});

test('a failed check is marked unknown, and retry runs the check again', async () => {
  let fail = true;
  const fake = fakeFetch(() =>
    fail
      ? respond(429, { error: 'Too many requests' })
      : respond(200, { enabled: true, linked: null }),
  );
  let hook: ReturnType<typeof useGoogleLink> | null = null;
  function Probe() {
    hook = useGoogleLink();
    return null;
  }
  try {
    const root = new TestRoot(Probe, {});
    await root.flush();
    assert.equal(hook![0]?.error, true, 'the failure is kept apart from "disabled"');
    assert.equal(typeof hook![2], 'function', 'a retry is offered');
    fail = false;
    hook![2]();
    await root.flush();
    assert.equal(fake.calls.length, 2, 'retry fetches again');
    assert.equal(hook![0]?.enabled, true);
    assert.equal(hook![0]?.error, undefined);
    root.unmount();
  } finally {
    fake.restore();
  }
});

test('Settings shows the failed check with Try again, not "isn\'t available"', () => {
  let retried = 0;
  const output = GoogleLinkCheckFailed({ onRetry: () => retried++ });
  assert.match(text(output), /Couldn't check Google sign-in/);
  assert.doesNotMatch(text(output), /isn.t available/);
  const retry = button(output, 'Try again');
  assert.ok(retry);
  (retry.props.onClick as () => void)();
  assert.equal(retried, 1);
});
