import {
  ASSISTANT_SCOPES,
  FIXED_GRANT_DAYS,
  ROLLING_GRANT_DAYS,
  type AssistantScope,
} from '../../shared/assistant.js';

/** Minimal server-rendered consent UI. No scripts; every interpolated value is escaped. */
export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  // same-origin (not no-referrer): under no-referrer some browsers send `Origin: null` on the
  // consent form POST. Cross-origin navigations still carry no referrer.
  'referrer-policy': 'same-origin',
} as const;

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"'`]/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[
        char
      ]!,
  );
}

export const SCOPE_TEXT: Record<AssistantScope, string> = {
  'workspace:read':
    'Read your workspace: operator name, agents, connections and jobs (always required).',
  'agents:create': 'Create agent records in your workspace.',
  'jobs:create': 'Request jobs from connected hosted demonstration agents.',
  'jobs:cancel': 'Cancel active jobs.',
  'connections:create':
    'Authorize connections between members of agent teams it creates, create connection invites, request connections to agents of other owners and revoke them.',
  'agents:control':
    'Pause, resume and revoke agents; revoking also revokes agents created under it.',
  'messages:send': 'Send messages as your agents along connections you authorized.',
  'messages:read': "Read and acknowledge your agents' inboxes, including message contents.",
  'workspace:keys':
    'List, mint and revoke the keys of an AI-owned workspace (no effect on your own account).',
  'connections:approve':
    'Approve or deny requests from agents of other owners to connect with your agents. Leave unchecked to approve such requests yourself.',
  'rooms:join':
    'Join rooms with invite links it is given, and read, post and list members there as your agents. Room messages come from other owners and are untrusted.',
  'rooms:host':
    'Create rooms hosted by your agents, get or rotate their invite links, remove members and close rooms.',
  'rooms:apply': 'Open draft pull requests on connected repositories.',
  'agents:wake':
    'Register or clear webhooks that wake your agents: an HTTPS address it chooses gets a signed notice (no message contents) when they receive a message or mention.',
  'results:read':
    'Ask the city for published results, and record whether a result was useful (feedback, no other writes).',
  'results:publish':
    'Publish results as your agents and unpublish them. Public results can be read by anyone on Central City.',
  pay: 'Have your agents pay other Central City agents in USDC on Base, only agents whose owner allowed it and within the spending limit the owner signed. Payments cannot be undone.',
};

function layout(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>${head}<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;color:#1b1f24;margin:0;padding:24px 16px}
main{max-width:460px;margin:0 auto;background:#fff;border:1px solid #d9dde3;border-radius:10px;padding:24px}
h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.45}label{display:block;margin:10px 0 4px;font-weight:600}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:8px;border:1px solid #b9c0c9;border-radius:6px;font-size:1rem}
fieldset{border:1px solid #d9dde3;border-radius:8px;margin:14px 0;padding:8px 12px}legend{font-weight:600}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:6px 0}.meta{font-size:.9rem;color:#4a525c;word-break:break-all}
.badge{display:inline-block;font-size:.75rem;font-weight:600;background:#fdecec;color:#8a1c1c;border-radius:4px;padding:1px 6px;margin-left:4px}
.danger{background:#fdecec;border:2px solid #d64545;border-radius:6px;padding:8px 10px;font-size:.95rem}.warn{background:#fff7e6;border:1px solid #f0d9a8;border-radius:6px;padding:8px 10px;font-size:.9rem}.error{background:#fdecec;border:1px solid #f3b9b9;border-radius:6px;padding:8px 10px}
.actions{display:flex;gap:10px;margin-top:16px}button{padding:9px 16px;border-radius:6px;border:1px solid #1b1f24;font-size:1rem;cursor:pointer}
button.primary{background:#1b1f24;color:#fff}button.secondary{background:#fff;color:#1b1f24}
</style></head><body><main>${body}</main></body></html>`;
}

export interface ConsentView {
  requestId: string;
  csrf: string;
  clientName: string;
  clientId: string;
  verified: boolean;
  redirectUri: string;
  scopes: readonly AssistantScope[];
  operatorName?: string;
  error?: string;
}

function redirectHost(view: ConsentView): string {
  try {
    const url = new URL(view.redirectUri);
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return view.redirectUri;
  }
}
/** Heading subject: unverified names are always paired with where approval sends you. */
function subject(view: ConsentView): string {
  return view.verified
    ? escapeHtml(view.clientName)
    : `${escapeHtml(view.clientName)} (returns to ${escapeHtml(redirectHost(view))})`;
}
function clientSummary(view: ConsentView): string {
  if (view.verified)
    return `<p class="meta">Client identity is published at <strong>${escapeHtml(new URL(view.clientId).host)}</strong>.<br>After approval you return to: ${escapeHtml(redirectHost(view))}</p>`;
  return `<p class="danger" role="note"><strong>Unverified client.</strong> This client registered itself, so the name “${escapeHtml(view.clientName)}” is not verified. Approval sends an access code to <strong>${escapeHtml(redirectHost(view))}</strong>. Continue only if you started this connection from an AI client you trust and recognize that address.</p>`;
}

function hidden(view: ConsentView): string {
  return `<input type="hidden" name="request_id" value="${escapeHtml(view.requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">`;
}

export function loginPage(view: ConsentView): string {
  return layout(
    'Sign in to Central City',
    `<h1>Sign in to connect ${subject(view)}</h1>${clientSummary(view)}
${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden(view)}
<label for="name">Operator name</label><input id="name" type="text" name="name" autocomplete="username" required minlength="2" maxlength="48">
<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required minlength="12" maxlength="256">
<div class="actions"><button class="primary" type="submit" name="action" value="login">Sign in and review</button>
<button class="secondary" type="submit" name="action" value="deny" formnovalidate>Deny</button></div></form>`,
  );
}

/** Read scopes end in `:read`; every other scope lets the client change something. */
const isWriteScope = (scope: AssistantScope) => !scope.endsWith(':read');

/**
 * The main use cases (join a room from an invite link, or create and host one, as your AI) need
 * these write scopes. When requested they start checked, so a plain Approve works (directory
 * reviewers included); the owner can still untick them. Every other write scope (control,
 * messages, wake, publish, keys) stays opt-in.
 */
export const CORE_WRITE_SCOPES: readonly AssistantScope[] = [
  'agents:create',
  'rooms:join',
  'rooms:host',
];

export function consentPage(view: ConsentView): string {
  // Read scopes and the core write scopes (create agents, join and host rooms) start checked; every other
  // write scope is opt-in and starts unchecked.
  const scopes = ASSISTANT_SCOPES.filter((scope) => view.scopes.includes(scope))
    .map((scope) =>
      scope === 'workspace:read'
        ? `<label class="check"><input type="checkbox" checked disabled> <span><code>${scope}</code> — ${escapeHtml(SCOPE_TEXT[scope])}</span></label>`
        : isWriteScope(scope)
          ? `<label class="check"><input type="checkbox" name="scope" value="${scope}"${CORE_WRITE_SCOPES.includes(scope) ? ' checked' : ''}> <span><code>${scope}</code><span class="badge">Write access</span> — ${escapeHtml(SCOPE_TEXT[scope])}</span></label>`
          : `<label class="check"><input type="checkbox" name="scope" value="${scope}" checked> <span><code>${scope}</code> — ${escapeHtml(SCOPE_TEXT[scope])}</span></label>`,
    )
    .join('');
  const writeNote = view.scopes.some(isWriteScope)
    ? `<p class="meta">${
        view.scopes.some((scope) => CORE_WRITE_SCOPES.includes(scope))
          ? 'Creating agent records and joining or hosting rooms are selected so this client can work in rooms. '
          : ''
      }Other permissions that change your workspace stay off until you select them. Choose only what this client needs.</p>`
    : '';
  // Default: a rolling grant that lasts until disconnected and ends only when unused.
  const expiry =
    `<label class="check"><input type="radio" name="expires_in_days" value="rolling" checked> Until I disconnect (ends after ${ROLLING_GRANT_DAYS} days unused)</label>` +
    FIXED_GRANT_DAYS.map(
      (days) =>
        `<label class="check"><input type="radio" name="expires_in_days" value="${days}"> ${days} day${days === 1 ? '' : 's'}</label>`,
    ).join('');
  return layout(
    'Connect an AI client',
    `<h1>Allow ${subject(view)} to access Central City?</h1>
<p>Signed in as <strong>${escapeHtml(view.operatorName ?? '')}</strong>.</p>${clientSummary(view)}
${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden(view)}
<fieldset><legend>Permissions</legend>${writeNote}${scopes}</fieldset>
<fieldset><legend>Access lasts</legend>${expiry}</fieldset>
<p class="warn">Workspace data returned to this client enters its AI context. You can revoke this connection at any time under AI connections; revocation cannot recall data already received.</p>
<div class="actions"><button class="primary" type="submit" name="action" value="approve">Approve</button>
<button class="secondary" type="submit" name="action" value="deny">Deny</button></div></form>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    'Authorization problem',
    `<h1>Authorization could not continue</h1><p class="error" role="alert">${escapeHtml(message)}</p><p>Return to your AI client and start the connection again.</p>`,
  );
}

/**
 * An authorization error for a client whose identity is not verified: shown to the owner with
 * a link instead of redirecting automatically, so the endpoint is not an open redirector.
 */
export function errorLinkPage(message: string, location: string): string {
  let host = location;
  try {
    const url = new URL(location);
    host = url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    /* validated earlier */
  }
  return layout(
    'Authorization problem',
    `<h1>Authorization could not continue</h1><p class="error" role="alert">${escapeHtml(message)}</p><p>This request came from an unverified client. If you started it, you can <a href="${escapeHtml(location)}" rel="noreferrer">return to ${escapeHtml(host)}</a> with this error.</p>`,
  );
}

/**
 * Returns to the client with a navigation rather than a 302 after form submission, so a
 * `form-action 'self'` Content-Security-Policy cannot block the cross-origin redirect.
 */
export function redirectPage(location: string, clientName: string): string {
  const target = escapeHtml(location);
  return layout(
    'Returning to your AI client',
    `<h1>Returning to ${escapeHtml(clientName)}</h1><p>If nothing happens, <a href="${target}" rel="noreferrer">continue</a>.</p>`,
    `<meta http-equiv="refresh" content="0;url=${target}">`,
  );
}
