import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_LINE,
  EMAIL_LOGO_URL,
  esc,
  newsletterConfirmEmail,
  newsletterFooter,
  newsletterHtml,
  welcomeEmail,
} from '../server/email/templates.js';

/** The HTML parts of the transactional emails (docs/EMAIL.md). Synthetic data only. */
const ORIGIN = 'https://city.example';
const CONFIRM = `${ORIGIN}/newsletter/confirm?t=test-token-0001`;

const imgs = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);

function assertSafe(html: string) {
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /role="presentation"/);
  assert.ok(!/<script/i.test(html), 'no JS');
  assert.ok(!/<link\b|@import|fonts\.googleapis/i.test(html), 'no external CSS or fonts');
  const images = imgs(html);
  assert.equal(images.length, 1, 'only the logo');
  assert.ok(images[0]!.includes(`src="${EMAIL_LOGO_URL}"`));
  assert.ok(images[0]!.includes('alt="Central City"'));
  assert.ok(!EMAIL_LOGO_URL.includes('?'), 'a fixed logo URL, no per-recipient parameters');
  for (const href of hrefs(html))
    assert.ok(!/utm_|[?&](mc_|trk|track|click)/i.test(href), `no tracking params: ${href}`);
  assert.ok(html.includes(esc(COMPANY_LINE)), 'the verbatim company line');
}

test('confirmation email: HTML part with button, fallback link and the approved copy', () => {
  const email = newsletterConfirmEmail({ confirmUrl: CONFIRM, origin: ORIGIN });
  assertSafe(email.html);
  const button = email.html.match(/<a href="([^"]*)"[^>]*class="cc-button"[^>]*>([^<]*)<\/a>/);
  assert.ok(button, 'a primary button');
  assert.equal(button[1], CONFIRM);
  assert.equal(button[2], 'Confirm subscription');
  assert.ok(email.html.includes('Button not working? Paste this link into your browser:'));
  assert.equal(hrefs(email.html).filter((href) => href === CONFIRM).length, 2);
  assert.ok(email.html.includes(`>${CONFIRM}</a>`), 'the raw link as fallback text');
  for (const sentence of [
    'Thanks for signing up for the Central City newsletter. Please confirm your email address to start receiving product news. We only write occasionally.',
    "Didn't sign up? Just ignore this email and you won't be subscribed. This link expires in 7 days.",
  ])
    assert.ok(email.html.includes(esc(sentence)), sentence);
  assert.ok(hrefs(email.html).includes(`${ORIGIN}/privacy`));
  assert.ok(!/unsubscribe/i.test(email.html));
  assert.equal(email.subject, 'Confirm your subscription to the Central City newsletter');
  assert.ok(email.html.includes('>Confirm your subscription</h1>'));
  assert.ok(email.html.includes('The Central City team'));
});

test('confirmation email: the text part (approved copy, URL on its own line)', () => {
  const email = newsletterConfirmEmail({ confirmUrl: CONFIRM, origin: ORIGIN });
  assert.equal(
    email.text,
    [
      'Hi,',
      '',
      'Thanks for signing up for the Central City newsletter. Please confirm your email address to start receiving product news. We only write occasionally.',
      '',
      CONFIRM,
      '',
      "Didn't sign up? Just ignore this email and you won't be subscribed. This link expires in 7 days.",
      '',
      'The Central City team',
      '',
      `--\n${COMPANY_LINE}\nPrivacy: ${ORIGIN}/privacy`,
    ].join('\n'),
  );
});

test('welcome email: HTML part with the approved copy, the name escaped', () => {
  const email = welcomeEmail({
    name: '<script>alert(1)</script> & Co',
    origin: ORIGIN,
    elric: true,
  });
  assertSafe(email.html);
  assert.ok(!email.html.includes('<script>alert'), 'the name is escaped');
  assert.ok(email.html.includes('Hi &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co,'));
  assert.ok(email.text.startsWith('Hi <script>alert(1)</script> & Co,'), 'text stays raw');
  for (const sentence of [
    "Welcome to Central City. It's where your AIs and the people you work with meet in shared rooms.",
    'Three things to try:',
    'Invite your AI. Connect ChatGPT, Claude, Cursor or Codex:',
    'Open a room and invite someone:',
    "Meet Elric, Central City's AI assistant (18+). Find it in the sidebar:",
    'Questions? Just reply to this email.',
    'You get this email because you created a Central City account.',
  ])
    assert.ok(email.html.includes(esc(sentence)), sentence);
  for (const url of ['/#connect', '/rooms', '/elric', '/docs', '/privacy'])
    assert.ok(hrefs(email.html).includes(`${ORIGIN}${url}`), url);
  const off = welcomeEmail({ name: 'Mail Person', origin: ORIGIN, elric: false });
  assert.ok(off.html.includes('Two things to try:'));
  assert.ok(!off.html.includes('/elric'));
  assert.ok(!/unsubscribe/i.test(off.html), 'the welcome email is transactional');
});

test('newsletter wrapper: footer with Unsubscribe, Settings and Privacy; headers unchanged', () => {
  const unsubscribeUrl = `${ORIGIN}/newsletter/unsubscribe?t=test-token-0002`;
  const settingsUrl = `${ORIGIN}/settings/account`;
  const footer = newsletterFooter({ unsubscribeUrl, settingsUrl });
  const html = newsletterHtml({
    title: 'Issue <1>',
    bodyHtml: '<p>Synthetic issue.</p>',
    footerHtml: footer.footerHtml,
  });
  assertSafe(html);
  assert.ok(html.includes('Issue &lt;1&gt;'));
  assert.ok(
    html.includes(esc('You get this because you subscribed to the Central City newsletter.')),
  );
  for (const url of [unsubscribeUrl, settingsUrl, `${ORIGIN}/privacy`])
    assert.ok(hrefs(html).includes(url), url);
  assert.deepEqual(footer.headers, {
    'List-Unsubscribe': `<${ORIGIN}/api/newsletter/unsubscribe?t=test-token-0002>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
});
