/**
 * Email texts (the approved copy; docs/EMAIL.md).
 * A plain-text part plus an HTML part with the same sentences. No tracking pixels, no click
 * tracking, no external fonts or CSS, no JS. The company footer line is fixed (COMPANY_LINE).
 */
export interface EmailText {
  subject: string;
  text: string;
  html: string;
}

/** The company line in every email footer (verbatim, approved). */
export const COMPANY_LINE =
  'Central City is operated within a holding structure. Parent company: La Cavina S.R.L., Torino (TO), Italy · Fiscal code and VAT no. 08302720019 · REA TO-961798 · Share capital €50,000.00.';

function footer(line: string): string {
  return `--\n${COMPANY_LINE}\n${line}`;
}

export function welcomeEmail(options: { name: string; origin: string; elric: boolean }): EmailText {
  const { name, origin, elric } = options;
  const steps = [
    `1. Invite your AI. Connect ChatGPT, Claude, Cursor or Codex:\n   ${origin}/#connect`,
    `2. Open a room and invite someone:\n   ${origin}/rooms`,
    // Step 3 only when Elric is on (CITY_ELRIC).
    ...(elric
      ? [
          `3. Meet Elric, Central City's AI assistant (18+). Find it in the sidebar:\n   ${origin}/elric`,
        ]
      : []),
  ];
  const subject = 'Welcome to Central City';
  const htmlSteps = [
    ['Invite your AI. Connect ChatGPT, Claude, Cursor or Codex:', `${origin}/#connect`],
    ['Open a room and invite someone:', `${origin}/rooms`],
    ...(elric
      ? [
          [
            "Meet Elric, Central City's AI assistant (18+). Find it in the sidebar:",
            `${origin}/elric`,
          ],
        ]
      : []),
  ]
    .map(
      ([label, url], index) =>
        `<tr><td style="padding:0 0 12px;font-size:16px;line-height:1.5;color:${C.ink};">${index + 1}. ${esc(label!)}<br>${link(url!)}</td></tr>`,
    )
    .join('');
  return {
    subject,
    html: layout({
      title: subject,
      body:
        heading(subject) +
        para(`Hi ${esc(name)},`) +
        para(
          esc(
            "Welcome to Central City. It's where your AIs and the people you work with meet in shared rooms.",
          ),
        ) +
        para(`${elric ? 'Three' : 'Two'} things to try:`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${htmlSteps}</table>` +
        button('Invite your AI', `${origin}/#connect`) +
        para(`Docs: ${link(`${origin}/docs`)}`, { muted: true }) +
        para('Questions? Just reply to this email.', { muted: true }) +
        para('Central City', { muted: true, last: true }),
      footer: footerHtml(
        `${esc('You get this email because you created a Central City account.')}<br>${footerLink('Privacy', `${origin}/privacy`)}`,
      ),
    }),
    text: [
      `Hi ${name},`,
      '',
      "Welcome to Central City. It's where your AIs and the people you work with meet in shared rooms.",
      '',
      `${elric ? 'Three' : 'Two'} things to try:`,
      '',
      steps.join('\n\n'),
      '',
      `Docs: ${origin}/docs`,
      'Questions? Just reply to this email.',
      '',
      'Central City',
      '',
      footer(
        `You get this email because you created a Central City account.\nPrivacy: ${origin}/privacy`,
      ),
    ].join('\n'),
  };
}

export function newsletterConfirmEmail(options: { confirmUrl: string; origin: string }): EmailText {
  const subject = 'Confirm your subscription to the Central City newsletter';
  const { confirmUrl, origin } = options;
  return {
    subject,
    html: layout({
      title: subject,
      body:
        heading('Confirm your subscription') +
        para('Hi,') +
        para(
          esc(
            'Thanks for signing up for the Central City newsletter. Please confirm your email address to start receiving product news. We only write occasionally.',
          ),
        ) +
        button('Confirm subscription', confirmUrl) +
        fallbackLink(confirmUrl) +
        para(
          esc(
            "Didn't sign up? Just ignore this email and you won't be subscribed. This link expires in 7 days.",
          ),
          { muted: true },
        ) +
        para('The Central City team', { muted: true, last: true }),
      footer: footerHtml(footerLink('Privacy', `${origin}/privacy`)),
    }),
    text: [
      'Hi,',
      '',
      'Thanks for signing up for the Central City newsletter. Please confirm your email address to start receiving product news. We only write occasionally.',
      '',
      options.confirmUrl,
      '',
      "Didn't sign up? Just ignore this email and you won't be subscribed. This link expires in 7 days.",
      '',
      'The Central City team',
      '',
      footer(`Privacy: ${options.origin}/privacy`),
    ].join('\n'),
  };
}

/** Where the drain puts the signed confirmation token (signed when the email is sent). */
export const CONFIRM_TOKEN_SLOT = '{confirm_token}';

/**
 * The footer and headers every newsletter issue carries (one-click unsubscribe, RFC 8058).
 * `unsubscribeUrl` is the page link (/newsletter/unsubscribe?t=…); the List-Unsubscribe header
 * points at the API route with the same token, which takes the mail client's one-click POST.
 */
export function newsletterFooter(options: {
  unsubscribeUrl: string;
  settingsUrl: string;
  origin?: string;
}): {
  footer: string;
  /** The same footer for the HTML part (goes in newsletterHtml's `footer`). */
  footerHtml: string;
  headers: Record<string, string>;
} {
  const origin = options.origin ?? new URL(options.settingsUrl).origin;
  return {
    footerHtml: footerHtml(
      `${esc('You get this because you subscribed to the Central City newsletter.')}<br>${footerLink('Unsubscribe', options.unsubscribeUrl)} · ${footerLink('Settings', options.settingsUrl)} · ${footerLink('Privacy', `${origin}/privacy`)}`,
    ),
    footer: footer(
      `You get this because you subscribed to the Central City newsletter.\nUnsubscribe: ${options.unsubscribeUrl} · Settings: ${options.settingsUrl}`,
    ),
    headers: {
      'List-Unsubscribe': `<${options.unsubscribeUrl.replace('/newsletter/unsubscribe?', '/api/newsletter/unsubscribe?')}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** A newsletter issue's HTML part: the issue body (already safe HTML) in the shared layout. */
export function newsletterHtml(options: {
  title: string;
  bodyHtml: string;
  footerHtml: string;
}): string {
  return layout({
    title: options.title,
    body: heading(esc(options.title)) + options.bodyHtml,
    footer: options.footerHtml,
  });
}

// ---- HTML layout (email-safe: tables, inline styles; colours from src/shell/tokens.css) ----

/** The logo: a fixed public asset, no per-recipient parameters. */
export const EMAIL_LOGO_URL = 'https://centralcity.ai/brand/central-city-mark.png';

const C = {
  page: '#f8f9fa', // --bg-surface
  card: '#ffffff', // --bg-surface-elevated
  border: '#e4e4e7', // --border
  ink: '#09090b', // --text-primary
  muted: '#52525b', // --text-muted
  accent: '#0066ff', // --accent
  accentText: '#0055d6', // --accent-text
  onAccent: '#ffffff', // --accent-contrast
};
const FONT =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Escapes text for HTML content and attribute values. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function heading(html: string): string {
  return `<h1 class="cc-ink" style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${C.ink};">${html}</h1>`;
}

function para(html: string, options: { muted?: boolean; last?: boolean } = {}): string {
  const color = options.muted ? C.muted : C.ink;
  const size = options.muted ? 14 : 16;
  return `<p class="${options.muted ? 'cc-muted' : 'cc-ink'}" style="margin:0 0 ${options.last ? 0 : 16}px;font-family:${FONT};font-size:${size}px;line-height:1.5;color:${color};">${html}</p>`;
}

function link(url: string): string {
  return `<a href="${esc(url)}" class="cc-link" style="color:${C.accentText};text-decoration:underline;word-break:break-all;">${esc(url)}</a>`;
}

function footerLink(label: string, url: string): string {
  return `<a href="${esc(url)}" class="cc-muted" style="color:${C.muted};text-decoration:underline;">${esc(label)}</a>`;
}

/** A bulletproof button (a table cell with the background, so Outlook draws it too). */
function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;"><tr><td align="center" bgcolor="${C.accent}" style="border-radius:12px;background:${C.accent};"><a href="${esc(url)}" class="cc-button" style="display:inline-block;padding:12px 24px;min-height:20px;line-height:20px;font-family:${FONT};font-size:16px;font-weight:600;color:${C.onAccent};text-decoration:none;border-radius:12px;">${esc(label)}</a></td></tr></table>`;
}

function fallbackLink(url: string): string {
  return `<p class="cc-muted" style="margin:0 0 24px;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">Button not working? Paste this link into your browser:<br><a href="${esc(url)}" class="cc-muted" style="color:${C.muted};text-decoration:underline;word-break:break-all;">${esc(url)}</a></p>`;
}

function footerHtml(lineHtml: string): string {
  return `<p class="cc-muted" style="margin:0 0 8px;">${esc(COMPANY_LINE)}</p><p class="cc-muted" style="margin:0;">${lineHtml}</p>`;
}

function layout(options: { title: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(options.title)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .cc-page { background:#09090b !important; }
  .cc-card { background:#18181b !important; border-color:#27272a !important; }
  .cc-ink { color:#fafafa !important; }
  .cc-muted { color:#a9b6cc !important; }
  .cc-link { color:#7aa7ff !important; }
}
@media (max-width: 600px) { .cc-pad { padding:24px !important; } }
</style>
</head>
<body class="cc-page" style="margin:0;padding:0;background:${C.page};">
<table role="presentation" class="cc-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td class="cc-card cc-pad" style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:36px;font-family:${FONT};font-size:16px;line-height:1.5;color:${C.ink};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;"><tr>
<td style="vertical-align:middle;padding-right:10px;"><img src="${EMAIL_LOGO_URL}" width="32" height="32" alt="Central City" style="display:block;border:0;width:32px;height:32px;border-radius:8px;"></td>
<td class="cc-ink" style="vertical-align:middle;font-family:${FONT};font-size:17px;font-weight:700;color:${C.ink};">Central City</td>
</tr></table>
${options.body}
</td></tr>
<tr><td class="cc-muted" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};text-align:center;">
${options.footer}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
