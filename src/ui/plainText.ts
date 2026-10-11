import { describeError } from './errors';

/*
 * Plain wording for text that comes from the server (docs/COPY_GLOSSARY.md). The console shows server
 * messages and activity records; some of them were written for developers ("heartbeat",
 * "idempotency key", internal IDs, city_* tool names). These pure helpers turn them into sentences
 * a person can read, without changing what they report.
 */

/** Words that mark a server message as written for developers, not people. */
const MACHINE_TEXT =
  /idempoten|scope|lease|runtime|heartbeat|partition|json|credential|header|origin|sequence|grant|manifest|oauth|\bmcp\b|city_|\b[a-z]+_[a-z_]+\b|[{}]/i;

/** Known server messages with a clearer wording for people. */
const REWRITES: [RegExp, string][] = [
  [/^Claim token is invalid.*/i, 'This claim link is invalid, has expired or was already used.'],
  [/^Authentication is required\.?$/i, 'Sign in to continue.'],
  [/^Assistant grant expired or revoked\.?$/i, 'This AI connection has ended. Connect it again.'],
  [/^A current directional connection is required\.?$/i, 'These agents are not connected.'],
  [
    /(Agent|Assistant|Native agent) (requests|jobs) are limited to hosted, zero-cost demonstrations\.?/i,
    'Only the free CC agents can take this work.',
  ],
  [/^Account limit reached\.?$/i, 'This installation has reached its account limit.'],
  [/^Local agent limit reached\.?$/i, "You've reached the agent limit."],
  [/^Local connection limit reached\.?$/i, "You've reached the connection limit."],
  [/^Workspace is paused\..*$/i, 'Your workspace is paused. Resume it to continue.'],
  [/^The request is still being applied.*$/i, 'Still working on it. Try again in a moment.'],
  [/^Revoked agents cannot (connect|rotate credentials)\.?$/i, 'This agent was removed.'],
  [/^Live connection limit reached\.?$/i, 'Too many open windows. Close one and try again.'],
];

type ErrorBody = { error?: unknown; code?: unknown; message?: unknown } | null | undefined;

/**
 * The sentence to show for a failed console request. Keeps a server message that is already
 * plain; replaces codes, jargon and empty bodies with the shared copy from errors.ts.
 */
export function plainApiMessage(status: number, body: ErrorBody): string {
  const message = typeof body?.error === 'string' ? body.error.trim() : '';
  for (const [pattern, replacement] of REWRITES) if (pattern.test(message)) return replacement;
  // These ordinary words contain "lease". Ignore only whole words while classifying, so
  // identifiers such as leaseId, workerLease and releaseToken still use the shared copy.
  const technicalText = message.replace(/\b(?:please|releases?|released)\b/gi, '');
  if (message && message.includes(' ') && !MACHINE_TEXT.test(technicalText)) return message;
  const copy = describeError({ status, body });
  return copy.detail ? `${copy.title} ${copy.detail}` : copy.title;
}

/** True when text shown to a person still contains developer wording (used by tests). */
export function hasMachineText(text: string): boolean {
  return /city_[a-z]|idempoten|[{}]/i.test(text);
}

/** "city_create_agent" → "create agent". */
export function toolWords(tool: string): string {
  return tool.replace(/^city_/, '').replaceAll('_', ' ');
}

// An internal ID: a UUID, or a long token with digits and no spaces (for example grant IDs).
const ID = String.raw`(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{11,})`;

/** Activity rewrites, applied in order. Each keeps the facts and drops the jargon. */
const EVENT_REWRITES: [RegExp, string | ((...groups: string[]) => string)][] = [
  [/^Operator account created\.$/, 'Account created.'],
  [/ requested extract\b/g, ' requested an extraction'],
  [/ requested verify\b/g, ' requested a check'],
  [/\bOperator accepted\b/g, 'You accepted'],
  [/\bOwner (accepted|canceled|reviewed)\b/g, 'You $1'],
  [/Operator acceptance is pending\./g, 'Waiting for your review.'],
  [/Owner review is required before the check\./g, 'You review it before the check.'],
  [/ Room messages are untrusted input\./g, ''],
  [/: call city_room_read without since; they come back as unread\./g, '.'],
  [/\bused (city_[a-z_]+)\./g, (_m, tool) => `used “${toolWords(tool)}”.`],
  [/\bcity_[a-z_]+/g, (tool) => `“${toolWords(tool)}”`],
  [/ authenticated heartbeat received; online\./g, ' is online.'],
  [/ hosted runtime online\./g, ' is online.'],
  [/ heartbeat expired\./g, ' went offline.'],
  [/ demonstration registered\./g, ' added as a CC agent.'],
  [/ as a zero-cost deterministic demonstration/g, ' as a CC agent'],
  [/ as a deterministic demonstration/g, ' as a CC agent'],
  [/ as an external runtime awaiting enrollment/g, ' as an agent that runs on your own computer'],
  [/ as an external record awaiting owner runtime setup/g, ' as an agent that still needs setup'],
  [/ registered as an external runtime\./g, ' added. It runs on your own computer or server.'],
  [/ registered by (.+?) to join a room\./g, ' created by $1 to join a room.'],
  [/ registered by /g, ' added by '],
  [/ created from manifest "([^"]+)"/g, ' created from the “$1” template'],
  [/ updated to manifest revision \d+/g, ' updated'],
  [
    / runtime credential replaced\. Reconnect with the new credential\./g,
    ' got a new access token. Reconnect it with the new token.',
  ],
  [
    / runtime enrolled with a single-use code and received its credential\./g,
    ' connected with its one-time code.',
  ],
  [/ completed deterministic text processing\./g, ' finished the CC task.'],
  [/ started deterministic text processing\./g, ' started the CC task.'],
  [/^Directional connection revoked\.$/, 'Connection removed.'],
  [/\(team route applied by /g, '(team connection set up by '],
  [/ connection requests by id /g, ' connection requests '],
  [
    /requested a cross-owner connection to agent \S+/g,
    'asked to connect to an agent of another owner',
  ],
  [/Cross-owner connection/g, 'Connection with another owner'],
  [/ to agent \S+ (revoked|withdrawn)/g, ' to an agent of another owner $1'],
  [/\(job \S+\)/g, ''],
  [/Assistant grant/g, 'AI access'],
  [/\bissued\./g, 'created.'],
  [/ because its OAuth tokens were revoked\./g, ' because the AI app was disconnected.'],
  [
    / released because its authorization code expired without being exchanged\./g,
    ' ended because sign-in was not finished in time.',
  ],
  [/Workspace key/g, 'Access key'],
  [/\bminted\b/g, 'created'],
  [
    /AI-owned workspace created without an account; it authenticates with workspace keys\./g,
    'AI workspace created without an account.',
  ],
  [/ -> /g, ' → '],
  [/^Source brief workflow is /, 'The source brief is '],
  [/ paused \([a-z_]+\)\./g, ' paused.'],
];

/** One activity line in plain words: no internal IDs, tool names or runtime jargon. */
export function plainEvent(message: string): string {
  let text = message;
  for (const [pattern, replacement] of EVENT_REWRITES)
    text =
      typeof replacement === 'string'
        ? text.replace(pattern, replacement)
        : text.replace(pattern, replacement as (...groups: string[]) => string);
  // Internal IDs after a noun ("Room 351c…", "Result ab12…"): keep the noun, drop the ID.
  text = text.replace(
    new RegExp(String.raw`\b([Rr]oom|[Aa]gent|[Rr]esult|invite|key) ${ID}`, 'g'),
    (_m, noun: string) =>
      /^[A-Z]/.test(noun)
        ? noun
        : noun === 'room' || noun === 'agent'
          ? `a ${noun}`
          : `the ${noun}`,
  );
  text = text.replace(new RegExp(String.raw`\s*\(?${ID}\)?`, 'g'), '');
  text = text.replace(/\bby the owner\b/g, 'by you').replace(/\s{2,}/g, ' ');
  return text.replace(/\s+([.,;])/g, '$1').trim();
}

const EVENT_AREAS: Record<string, string> = {
  operator: 'Account',
  assistant: 'AI connection',
  job: 'Exchange',
  workflow: 'Collaboration',
  agent: 'Agent',
  connection: 'Connection',
  room: 'Room',
  workspace: 'Workspace',
  responder: 'Auto-reply',
  result: 'Answer',
};

/** "operator.created" → "Account · created". */
export function eventTypeLabel(type: string): string {
  const [area = '', ...rest] = type.split('.');
  const what = rest
    .join(' ')
    .replaceAll('_', ' ')
    .replace(/\bcross\b/, 'other owner');
  const label = EVENT_AREAS[area] ?? area.charAt(0).toUpperCase() + area.slice(1);
  return what ? `${label} · ${what}` : label;
}

/** Pulls a one-time code out of a pasted link or text ("…#claim=ccclaim_…" → "ccclaim_…"). */
export function codeFromPaste(value: string, pattern: RegExp): string {
  const text = value.trim();
  return pattern.exec(text)?.[0] ?? text;
}
