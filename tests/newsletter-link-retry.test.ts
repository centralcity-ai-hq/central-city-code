import test from 'node:test';
import assert from 'node:assert/strict';
import { TestRoot, button, text } from './helpers/hook-render.js';

const globals = globalThis as unknown as { window?: unknown; document?: unknown };
globals.window ??= { location: { search: '?t=signed-token', pathname: '/newsletter/unsubscribe' } };
globals.document ??= { title: '' };

const { NewsletterLinkPage } = await import('../src/NewsletterLink.js');

/*
 * /newsletter/confirm and /newsletter/unsubscribe: only the server's 400 (newsletter_link_invalid)
 * means the link is bad. A rate limit, a server error or a network failure keeps the button so the
 * person can try again, and never says the link is invalid.
 */

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function press(answer: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string) => {
    calls.push(String(path));
    return answer();
  }) as typeof fetch;
  const root = new TestRoot(NewsletterLinkPage, { action: 'unsubscribe' as const });
  const go = button(root.output, 'Unsubscribe');
  assert.ok(go, 'the Unsubscribe button is drawn');
  (go.props.onClick as () => void)();
  await root.flush();
  return { root, calls, restore: () => (globalThis.fetch = realFetch) };
}

for (const [name, answer] of [
  ['a 429', () => respond(429, { error: 'Too many requests', code: 'rate_limited' })],
  ['a 500', () => respond(500, { error: 'Something went wrong' })],
  [
    'a network failure',
    () => {
      throw new TypeError('Failed to fetch');
    },
  ],
] as const) {
  test(`${name} keeps the button and says to try again, not that the link is invalid`, async () => {
    const { root, calls, restore } = await press(answer);
    try {
      assert.equal(calls.length, 1);
      const shown = text(root.output);
      assert.doesNotMatch(shown, /invalid/);
      assert.match(shown, /That didn't go through\. Try again\./);
      const again = button(root.output, 'Unsubscribe');
      assert.ok(again, 'the button stays');
      assert.equal(again.props.disabled, false);
      root.unmount();
    } finally {
      restore();
    }
  });
}

test('the server saying the link is invalid (400) still shows the invalid text', async () => {
  const { root, restore } = await press(() =>
    respond(400, { error: 'This unsubscribe link is invalid.', code: 'newsletter_link_invalid' }),
  );
  try {
    assert.match(text(root.output), /This unsubscribe link is invalid\./);
    assert.equal(button(root.output, 'Unsubscribe'), undefined);
    root.unmount();
  } finally {
    restore();
  }
});
