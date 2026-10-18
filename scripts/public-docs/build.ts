/**
 * Public Markdown docs for AIs, served from centralcity.ai.
 *
 * The engineering docs in docs/*.md are written for contributors: they mention migrations, test
 * files, review history and internal plans. AIs need the product contract: endpoints, tools,
 * formats, limits and errors. This module builds a public subset at build time:
 *
 *   dist/docs/<slug>.md   one page per entry in PUBLIC_DOCS
 *   dist/docs-index.md    the list of pages, served at /docs/index.md and /docs.md by rewrites
 *
 * The index must not be a file inside dist/docs/ or next to it as docs.md: Vercel then answers
 * /docs itself with that file, and browsers get raw Markdown instead of the docs app.
 *
 * Each page keeps only the intro and the H2 sections listed in `keep` (an allowlist, so a new
 * internal section added to a source doc never becomes public by accident), applies the listed
 * clean-ups, rewrites links between docs, and then must pass `assertPublicSafe`. A page that fails
 * the check fails the build, naming the offending lines.
 *
 * vite.config.ts runs it after the bundle is written. tests/public-docs.test.ts runs it into a
 * temporary directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://centralcity.ai';
/** The index file in dist/; vercel.json rewrites /docs/index.md and /docs.md to it. */
export const DOCS_INDEX_FILE = 'docs-index.md';
const PROTOCOL_DOCS = 'https://github.com/centralcity-ai-hq/protocol/blob/main/docs';
const TOOLKIT_DOCS = 'https://github.com/centralcity-ai-hq/toolkit/blob/main/docs';

type Replace = [RegExp, string];

export interface PublicDoc {
  /** Served at /docs/<slug>.md. */
  slug: string;
  /** Source file in docs/. */
  source: string;
  title: string;
  /** One line for the index. */
  summary: string;
  /** Replaces the source intro (everything before the first H2). */
  intro?: string;
  /** H2 headings to keep (exact text after `## `), in source order. */
  keep: string[];
  /** Renames of kept H2 headings. */
  rename?: Record<string, string>;
  /** Paragraphs or list items matching any of these are dropped. */
  dropBlocks?: RegExp[];
  /** Applied in order to the kept text. */
  replace?: Replace[];
}

/**
 * Optional extra patterns for a checkout that has scripts/public-docs/private-patterns.ts (names
 * of internal repositories, people and references). Without the file only the generic patterns
 * in this module apply. A file that exists but fails to load fails the build.
 */
interface PrivatePatterns {
  PRIVATE_REPLACE?: Replace[];
  PRIVATE_FORBIDDEN?: Array<[RegExp, string]>;
}
const PRIVATE_PATTERNS_URL = new URL('./private-patterns.ts', import.meta.url);
const privatePatterns: PrivatePatterns = existsSync(fileURLToPath(PRIVATE_PATTERNS_URL))
  ? ((await import(PRIVATE_PATTERNS_URL.href)) as PrivatePatterns)
  : {};

/** Where other docs live publicly, for link rewriting. */
const EXTERNAL_DOCS: Record<string, string> = {
  'AGENT_MANIFEST.md': `${PROTOCOL_DOCS}/AGENT_MANIFEST.md`,
  'AI_WORKSPACES.md': `${PROTOCOL_DOCS}/AI_WORKSPACES.md`,
  'ASSISTANT_CONNECTION.md': `${PROTOCOL_DOCS}/ASSISTANT_CONNECTION.md`,
  'A2A_TRANSPORT.md': `${PROTOCOL_DOCS}/A2A_TRANSPORT.md`,
  'MESSAGING.md': `${PROTOCOL_DOCS}/MESSAGING.md`,
  'CONNECTOR.md': `${TOOLKIT_DOCS}/CONNECTOR.md`,
};

/** Clean-ups applied to every page. */
const COMMON_REPLACE: Replace[] = [
  [/<!--[\s\S]*?-->/g, ''],
  ...(privatePatterns.PRIVATE_REPLACE ?? []),
  [/\s*\(playbook [A-Z]\d+\)/g, ''],
  [/\s*\((?:app )?PR #?\d+[^()]*\)/g, ''],
  [/,? ?\(?#\d+\)?(?=[):,])/g, ''],
  [/ *\((?:migrations? \d+(?:, \d+)*(?: and \d+)?)[^()]*\)/g, ''],
  // Source file references: "(`server/wake/cron.ts`)", "(`SOURCE_PATH_DENYLIST` in `server/…`)".
  [/ *\([^()\n]{0,80}`(?:server|src|api|scripts|shared)\/[^`\n]+`[^()\n]{0,80}\)/g, ''],
  [/ \((?:requires )?F\d public reachability\)| Requires F\d public reachability\./g, ''],
  [/ \(F\d\)/g, ''],
  [/https:\/\/<host>/g, 'https://centralcity.ai'],
];

/** Paragraphs or list items dropped from every page. */
const COMMON_DROP: RegExp[] = [
  /^(?:- )?(?:\*\*)?(?:Code|Tests?|Spec|Wiring)(?:\*\*)?:/,
  /\btests\/[\w./-]+\.test\.ts\b/,
  /^Tests override /,
  /^Replace `<host>`/,
];

export const PUBLIC_DOCS: PublicDoc[] = [
  {
    slug: 'elric',
    source: 'ELRIC_ABOUT.md',
    title: 'Elric, your AI assistant',
    summary:
      'What Elric is, who can use it (18+, owner only), where it works, approvals, the on/off switches and the daily limits.',
    keep: [
      'Who can use it',
      'Where it works',
      'What it can do',
      'On and off',
      'Limits',
      'Your data',
    ],
  },
  {
    slug: 'invite',
    source: 'INVITE_GUIDE.md',
    title: 'Invite people and AIs to your room',
    summary:
      'Step by step in the app: invite a person, bring your own AI (ChatGPT, Claude and more), join from a link, add Elric, remove a member.',
    keep: [
      'Invite a person',
      'Bring your own AI',
      'Join a room from a link',
      'Add Elric to a room',
      'Remove a member',
    ],
  },
  {
    slug: 'wallet',
    source: 'WALLET_GUIDE.md',
    title: 'Agent wallets, Pay and Rating',
    summary:
      "Step by step in the app: your wallet key (set up, unlock, change the password, restore with the backup key), an agent's USDC wallet on Base, Add funds, Withdraw, spending limits, paying another Central City agent, paying again once Base settles a payment, and rating another Central City agent.",
    keep: [
      'Services and activity',
      'Set up your wallet key',
      'Keep your backup key safe',
      'Unlock your wallet key',
      'Change the password',
      'Forgot your password? Restore with your backup key',
      "An agent's wallet",
      'Add funds',
      'Withdraw',
      'Spending limits',
      'Pay another Central City agent',
      'Paying again and finality',
      'Rate another Central City agent',
      'Network fees',
    ],
  },
  {
    slug: 'base',
    source: 'BASE_AGENTS_GUIDE.md',
    title: 'Base agents, passports and inviting agents',
    summary:
      "Step by step in the app: what a Base agent is, making an agent a Base agent (its Base ID and wallet on Base, finality), the passport number (CC-…) versus the Base ID, the passport page, the Agent Explorer and Verify, inviting an agent to a room by its passport number, answering an invitation in the agent's Messages, the Room invitations setting, Pay and Rate, and network fees.",
    keep: [
      'What a Base agent is',
      'Make an agent a Base agent',
      'Base ID and passport number',
      'The passport page',
      'The Agent Explorer',
      'Invite an agent to a room',
      'Answer an invitation to your agent',
      'Room invitations setting',
      'Pay and rate a Base agent',
      'Network fees and what Central City covers',
      'Common questions',
    ],
  },
  {
    slug: 'protocol-fees',
    source: 'PROTOCOL_FEES.md',
    title: 'Protocol fees and revenue',
    summary: 'Fee calculation, reported revenue, agent contributions, finality and verification.',
    keep: [
      'Fee calculation',
      'What the totals include',
      'Reporting periods',
      'Refunds and corrections',
      'Verification and privacy',
    ],
  },
  {
    slug: 'feed',
    source: 'FEED_GUIDE.md',
    title: 'How the Feed works',
    summary:
      'Offered and Searched for: what the Feed lists, how a service is used today, how to post and answer a request, and the public read API.',
    keep: [
      'Offered',
      'Use a service',
      'Searched for',
      'Post a request',
      'Reply handles',
      'Your private link',
      'How we count',
      'For AIs and developers',
    ],
  },
  {
    slug: 'api',
    source: 'REMOTE_MCP.md',
    title: 'API: remote MCP and OAuth',
    summary:
      'The two MCP endpoints, every tool with its scope, OAuth 2.1, the no-account open endpoint, claim links, runtime enrollment and signed Agent Cards.',
    intro: [
      'Central City has two remote MCP endpoints (Streamable HTTP):',
      '',
      '- `https://centralcity.ai/mcp`: OAuth 2.1 (or an AI workspace key) on every request. The owner approves scopes and an expiry on a consent page.',
      '- `https://centralcity.ai/mcp/open`: no account. Plan and create zero-cost agents that start unclaimed, create an AI-owned workspace, or join a room from an invite link.',
      '',
      'The short guide for AIs is [llms.txt](/llms.txt); everything in one file is [llms-full.txt](/llms-full.txt). Rooms, [room management](/docs/room-management.md) (the host controls), join links, wake-up and answers have their own pages: [docs index](/docs/index.md).',
    ].join('\n'),
    keep: [
      'Endpoints',
      'Tools and scopes',
      'Runtime enrollment',
      'Open endpoint: connect with no account',
      'Anonymous mode (unclaimed agents)',
      'Agent Cards and signing',
      'Connecting clients',
      'Authorization flow',
      'Security notes',
    ],
    dropBlocks: [
      /Reachability/,
      /Deployment Protection/,
      /\bstaging\b/i,
      /^\*\*Partition design\.\*\*/,
      /^\*\*Capacity accounting\.\*\*/,
      /^When pressure is `high`/,
      /^- In hosted mode only configured HTTPS origins/,
      /^- OAuth tables are authority/,
    ],
    replace: [
      [
        /; the global caps are deliberately large, and reclaiming capacity is an operator decision\s+\(see \[Abuse response\]\(#abuse-response\)\)\./,
        '.',
      ],
      [/ \(for local testing, `http:\/\/127\.0\.0\.1:4310`\)/, ''],
      [
        /, all infrastructure-level and configurable \(`CITY_LIMIT_\*`\), applied to four\s+nested address scopes from `clientAddressPrefixes`:/,
        ', applied to four nested address scopes:',
      ],
      [
        /\| Limit \| Default \| Variable \|[\s\S]*?`CITY_LIMIT_UNCLAIMED_BUCKETS_GLOBAL` \|/,
        [
          '| Limit | Default |',
          '  | --- | --- |',
          '  | Anonymous calls per source | 60 / minute |',
          '  | Create/apply per source / site / network / region | 200 / 200 / 300 / 500 per hour |',
          '  | Unclaimed agents per source / site / network / region | 200 / 500 / 1000 / 5000 |',
          '  | Unclaimed agents per deployment | 10000000 |',
          '  | Unclaimed partitions per deployment | 200000 |',
        ].join('\n'),
      ],
      [
        / Configure `CITY_SIGNING_KEY` as a private Ed25519[\s\S]*?an empty JWKS\./,
        ' During a key rotation the retired key stays in the JWKS for verification only and never signs.',
      ],
      [
        / \(an HMAC of the\s+operator id keyed by `CITY_RATE_LIMIT_KEY`\)/,
        ' (an HMAC of the account id)',
      ],
    ],
  },
  {
    slug: 'rooms',
    source: 'ROOMS.md',
    title: 'Rooms',
    summary:
      'Shared threads for agents and people of any owner: links, tools, room templates, read cursors, history, limits and how to treat room messages.',
    keep: [
      'Links and tokens',
      'MCP tools',
      'Search',
      'Pins and the handoff brief',
      'Room templates',
      'Authorization and ordering',
      'Limits (defaults)',
      'Untrusted content',
      'People in rooms (migration 31)',
    ],
    rename: { 'People in rooms (migration 31)': 'People in rooms' },
    dropBlocks: [/^- (?:Code|Tests|Storage):/],
    replace: [
      [
        /\*\*Behaviour change \(unread by default, #\d+\):\*\* `city_room_read` without `since` used to return\s+everything you may see\. It now returns/,
        '**Unread by default:** `city_room_read` without `since` returns',
      ],
      [
        / The server secret is\s+`CITY_RATE_LIMIT_KEY` \(hosted mode requires it\)\. Locally without it, a random per-process secret is\s+used: after a restart the old link stops working and the next link read issues a new one\./,
        '',
      ],
      [/,?\s*\[MEMBER_STATUS\.md\]\(MEMBER_STATUS\.md\)/g, ''],
      [/ Migrations? [\d and]+ raised open rooms still at the old defaults? of [\d and]+\./, ''],
      [/ \(`wake_outbox` is for agents only\)/, ''],
      [/`room_members\.kind = 'person'`/, "`kind: 'person'`"],
    ],
  },
  {
    slug: 'room-management',
    source: 'ROOM_MANAGEMENT.md',
    title: 'Room management',
    summary:
      "The host's controls: rename and topic, remove with a reason and a rejoin block, mute, delete, and their errors; muting a room for yourself.",
    keep: [
      'Rename and topic',
      'Delete a room',
      'Remove a member with a reason',
      'Mute a member',
      'Mute a room for yourself',
      'Reasons are plain text',
      'Errors',
    ],
  },
  {
    slug: 'coding',
    source: 'CODING_IN_ROOMS.md',
    title: 'Coding in rooms',
    summary:
      'Connect a GitHub repository to a room: read files, propose and review changes, open a draft pull request, read the checks. For approved accounts.',
    keep: [
      'Connect a repository',
      'Read the code',
      'Propose a change',
      'Review',
      'Open a draft pull request',
      'Check results',
      'For hosts: applying runs the proposed code in your CI',
      'Who can do what',
      'Limits',
    ],
  },
  {
    slug: 'microsoft-copilot',
    source: 'MICROSOFT_COPILOT.md',
    title: 'Microsoft Copilot',
    summary:
      'Add Central City to Copilot Studio, Microsoft 365 Copilot or Agent 365 as an MCP server, with OAuth or no sign-in.',
    keep: [
      'Which address to use',
      'Copilot Studio',
      'Microsoft 365 Copilot (declarative agent)',
      'Agent 365 (org admins)',
      'In the room',
    ],
  },
  {
    slug: 'mistral-le-chat',
    source: 'MISTRAL_LE_CHAT.md',
    title: 'Mistral Le Chat',
    summary:
      'Add Central City to Le Chat (all plans, Free included) or Mistral AI Studio as a custom MCP connector, with OAuth or no sign-in.',
    keep: ['Le Chat', 'Mistral AI Studio (developers)', 'In the room'],
  },
  {
    slug: 'join-links',
    source: 'JOIN_LINKS.md',
    title: 'Join links',
    summary:
      'One `/j/<code>` link (or short code) for people and AIs: formats, short codes, what a link reveals and how an AI joins.',
    keep: ['Create a link', 'Open a link: `GET /j/<code>`', 'For AIs', 'Revoke one invitation'],
    replace: [
      [
        / On Vercel, `\/j\/:code` is rewritten[\s\S]*?\(`REWRITE_PREFIXES` in `api\/index\.ts`\), so the code never travels in a query string\./,
        '',
      ],
      [/ Codes minted before this change \(an unkeyed SHA-256\)[^.]*\.[^.]*\./, ''],
      [/ \(`join_links\.short_hash`\)/, ''],
      [/an HMAC of its `join_links` row id/, "an HMAC of the link's internal id"],
      [/\nRoom-link minting now uses[^\n]*\n?/, '\n'],
    ],
  },
  {
    slug: 'responder',
    source: 'RESPONDER.md',
    title: 'Auto-reply',
    summary:
      "A room member AI replies automatically when @mentioned, using its owner's own OpenAI or Anthropic key: key validation, models, caps and the console API.",
    intro: [
      "A room member AI can reply automatically when it is @mentioned. Central City calls OpenAI or Anthropic with the **owner's own API key** and posts the reply as that member, labelled **Auto-reply**. Central City never pays for model calls.",
      '',
      'Only the signed-in owner turns auto-reply on, in the console: there is no MCP tool for it, so no AI can store a key or change a cap.',
    ].join('\n'),
    keep: ['Validation', 'Console API (the signed-in owner only)'],
    rename: { 'Console API (the signed-in owner only)': 'Console API' },
    dropBlocks: [/^- \*\*Later, with S\d:\*\*/],
    replace: [
      [
        /, and the limit fails closed during a limiter outage \(the `responder-\*` limiter prefixes are fail-closed\)/,
        ', and the limit fails closed during a limiter outage',
      ],
      [/ Remove it from the allowlist before it retires\./, ''],
    ],
  },
  {
    slug: 'room-tasks',
    source: 'ROOM_TASKS.md',
    title: 'Room tasks',
    summary:
      'Work items inside a room: create (optionally from a built-in template), claim with a lease, renew, release, post a result for review, ask a member for a peer review, discuss each task in its comment thread, and the fifteen MCP tools.',
    intro: [
      'Room tasks are work items that live in a room. A member creates a task, another member claims it with a lease, renews or releases the claim, and posts a result for review; the host approves, rejects or cancels it. Every change is kept in an append-only task log that room members can read, and each task has a comment thread for discussing it outside the main conversation.',
      '',
      'The tools are on `/mcp` (OAuth grant or AI workspace key, scope `rooms:join`), not on `/mcp/open` and not for room-only guest credentials.',
    ].join('\n'),
    keep: [
      'Claiming',
      'Results and review',
      'Stages',
      'Templates',
      'Comments',
      'Limits',
      'MCP tools',
    ],
    dropBlocks: [
      /^Storage \(migration/,
      /^Registration: /,
      /^Tool descriptions \(final text/,
      /^- `city_room_task_\w+`: "/,
      /^Wiring \(/,
    ],
    replace: [
      [/`city_room_task_claim`, PR3\)/, '`city_room_task_claim`)'],
      [
        / The batch-limited sweep `sweepLapsedTasks\(db, limit\)`\s+\(PR2\) only bounds staleness: one `UPDATE … RETURNING` lapses past-grace claims\s+with one `lapsed` event each\. No cron is wired in PR2(?: \([^)]*\))?; lazy\s+lapse stays\./,
        '',
      ],
      [/ \(PR2, plan A2\)/, ''],
      [/`city_room_task_result`, PR2\)/, '`city_room_task_result`)'],
      [
        /\s+\(step 2 is not merged, so the shape is validated by zod and stored as-is; tests\s+use fake step-2 evidence\)/,
        '',
      ],
      [/ \(06c, the same window renew\s+allows\)/, ' (the same window renew allows)'],
      [/`city_room_task_(?:update|review)`, PR2\)/, '`city_room_task_review`)'],
      [/, 06c \+ PR3\)/, ')'],
      [/ Until that table exists, any\s+non-empty list fails closed\./, ''],
      [
        / — charged \*\*before\*\* the\s+transaction \(the hosted limiter needs its own pool client; the pool holds 3\)\./,
        '.',
      ],
      [/ one conditional `UPDATE … RETURNING` takes an\s+open task/, ' takes an open task'],
      [
        /: the claim UPDATE only matches `status IN \('open','claimed'\)`, so a\s+claim on a closed task falls through to/,
        ': a claim on a closed task gets',
      ],
      [
        / the next read clears the whole `claim_\*` group and\s+flips `status` to `open` in the same statement \(plus a `lapsed` event\), so no cron\s+is needed for correctness\./,
        ' the next read reopens the task (plus a `lapsed` event).',
      ],
      [
        /, clears the\s+claim group CHECK-safely in the same statement, and kills the token/,
        ', clears the claim and ends the token',
      ],
      [
        /Fifteen tools, all scope `rooms:join` \(host take-over \/ force-release \/ review\s+additionally need host authority\)\.[\s\S]*?\(`city_room_task_\*`\)\./,
        'Fifteen tools, all with scope `rooms:join` (force-release and review also need the host; a review request needs the host or the claimer; a peer review needs the requested reviewer).',
      ],
      [/Annotations \(per TASK_09 review\): /, 'Annotations: '],
      [/Post step-2 proposal evidence/, 'Post evidence'],
    ],
  },
  {
    slug: 'wake',
    source: 'WAKE.md',
    title: '@mentions and wake-up',
    summary:
      'Get woken within seconds instead of polling: @mentions, long-poll `wait`, SSE and signed webhooks.',
    keep: ['Mentions', 'Tools (MCP)', 'Long-poll', 'Stream (SSE)', 'Webhooks'],
    dropBlocks: [
      /^\*\*Storage\.\*\*/,
      /^\*\*Cost note\.\*\*/,
      /^\*\*No connection is held while waiting\.\*\*/,
      /^- \*\*(?:Same|Other) instance/,
      /^So N waiters cost/,
      /^`agents:wake` is a new scope/,
    ],
    replace: [
      [
        /\*\*Root key and rotation\.\*\*[\s\S]*?the old signatures stop\.\n/,
        'During a key rotation a delivery carries one signature per key, current first (`webhook-signature: v1,<new> v1,<old>`, `webhook-key-id: k_new k_old`); call `city_set_wake_webhook` again to get a secret under the new key.\n',
      ],
      [
        / It is derived with HMAC from the wake\s+root key and a per-webhook salt, and it is never stored\./,
        ' It is never stored.',
      ],
      [/\n- These are the same rules as the Client ID Metadata Document fetcher\.?\n/, '\n'],
      [/\n`server\/wake\/webhooks\.ts` exports `verifyWebhook` as a reference\./, ''],
      [/ `server\/wake\/webhooks\.ts` exports `verifyWebhook` as a reference\./, ''],
      [
        /\n1\. The event's transaction upserts one pending row per webhook into `wake_outbox`\.[\s\S]*?3\. On Vercel the drain runs under `waitUntil`, so it outlives the response\./,
        '\nWake-ups for one webhook are coalesced: events that arrive before a delivery succeeds are merged into it (`kinds` merged, `pending` counts them).',
      ],
      [
        /Short backoffs are retried in-process for up to 12 s\. Longer ones are retried by the next drain\s+on that instance: the next wake event, a long-poll or stream, or, in local mode, a 2 s timer\./,
        'Short backoffs are retried within seconds; longer ones by the next drain, which also runs on a schedule every minute.',
      ],
      [/ \(the rate limiter; PostgreSQL when hosted\)/, ''],
    ],
  },
  {
    slug: 'answers',
    source: 'ANSWERS.md',
    title: 'Answers: exchange before compute',
    summary:
      'Ask whether another agent already published a result before computing it, reuse it with provenance, and publish your own.',
    keep: [
      'Tools (MCP) and scopes',
      'Result and match',
      'Publishing',
      'Asking and ranking',
      'Reuse reports, flags and principals',
      'Idempotency',
      'Limits (defaults, `CITY_LIMIT_*` overrides in `server/limits.ts`)',
      'Errors',
    ],
    rename: {
      'Limits (defaults, `CITY_LIMIT_*` overrides in `server/limits.ts`)': 'Limits (defaults)',
    },
    dropBlocks: [/^Configuration lives in `RESULT_CONFIG`/, /^\*\*Network key\.\*\*/],
    replace: [
      [/ \(the owner label follows the F\d rule:/, ' (the owner label follows the rooms rule:'],
      [/Only the D\d+ ask timeout keeps/, 'Only the ask timeout keeps'],
      [/ \(`operator_links`\)/, ''],
      [/ \(`ai_workspaces\.created_at`\)/, ''],
      [
        / \(the stored key is an HMAC under `CITY_RATE_LIMIT_KEY`\)/,
        ' (only a keyed HMAC is stored)',
      ],
      [
        /Both windows are fixed windows: on the shared hosted\s+limiter they are aligned to the UTC day \(a "24 h" window resets at 00:00 UTC, so two reports just\s+either side of midnight fall in different windows\); the local in-memory limiter starts a window at\s+its first hit\./,
        'Both windows are fixed windows aligned to the UTC day: a "24 h" window resets at 00:00 UTC, so two reports just either side of midnight fall in different windows.',
      ],
      [/ \(never inside one: the hosted pool holds three\s+clients\)/, ''],
      [
        /one network key\s+\(`clientAddressKey\(request\.ip\)`\)/,
        'one network key (the client address, IPv6 grouped by /64)',
      ],
      [
        /a pinned denylist \(`SOURCE_PATH_DENYLIST` in `server\/results\/sources\.ts`, reviewed at each\s+release\)/,
        'a pinned denylist (reviewed at each release)',
      ],
      [
        / \(`operators\.created_at`, added by migration \d+ and backfilled with the migration[^)]*\)/,
        '',
      ],
    ],
  },
];

/**
 * Text that must never appear in a public page: raw links, internal plans, review references,
 * source paths, table names, deployment configuration and secret values, plus the optional
 * private patterns loaded above.
 */
export const FORBIDDEN: Array<[RegExp, string]> = [
  [/raw\.githubusercontent\.com/, 'raw GitHub link'],
  ...(privatePatterns.PRIVATE_FORBIDDEN ?? []),
  [/\bF\d\b|\bB\d TTL\b/, 'internal feature reference'],
  [/\bPR ?#?\d+\b|\bPR\d\b|\(#\d+\)/, 'pull request reference'],
  [/\bTASK_\d+|\bROOMS-SEC-\d+|\bM\d\.\d\b/, 'internal task reference'],
  [/\bTODO\b|\bFIXME\b|\bwiring pending\b/i, 'unfinished note'],
  [/`(?:server|src|api|scripts|shared|tests)\/[^`]*`/, 'private source path'],
  [/\b[Mm]igration \d+/, 'migration reference'],
  [
    /\b(?:join_links|room_members|room_messages|room_tasks|room_task_events|room_task_comments|wake_outbox|wake_cursors|inbox_cursors|operator_links|ai_workspaces|unclaimed_stats|unclaimed_buckets|public_stats)\b/,
    'internal table name',
  ],
  // Deployment configuration: variable names, pool sizes and proxy settings stay out of public pages.
  [
    /\b(?:CITY|VERCEL|NEON|PG|OPENAI|ANTHROPIC)_[A-Z0-9_]+\b|\b(?:DATABASE_URL|CRON_SECRET|GITLEAKS_BIN)\b/,
    'configuration variable',
  ],
  [
    /\bpool (?:holds|client|size)\b|\bpool of \d+\b|\btrustProxy\b|\bproxy hops?\b|\bconfigured hops\b/i,
    'deployment internals',
  ],
  [
    /\b(?:hosted mode|hosted pool|hosted limiter|in-memory limiter|local development and tests|per-process (?:random )?(?:key|secret))\b/i,
    'deployment internals',
  ],
  // Secret values (the docs describe formats such as `ccw_…`, never real values).
  [/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z ]*-----/, 'PEM block'],
  [
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/]+:[^\s@/]+@/i,
    'database URL with credentials',
  ],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/, 'API key'],
  [
    /\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    'API key',
  ],
  [
    /\b(?:ccw|ccwclaim|ccclaim|crr|crc|cce|cca|ccr|whsec)_[A-Za-z0-9_-]{16,}/,
    'Central City credential',
  ],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JSON Web Token'],
  [
    /\b(?:secret|password|passwd|token|api[_-]?key|private[_-]?key)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9+/_=-]{24,}/i,
    'secret assignment',
  ],
  [/\b(?:step-2|step 2|plan §|S\d:)/, 'internal plan reference'],
];

export function assertPublicSafe(name: string, text: string): void {
  const problems: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const [pattern, label] of FORBIDDEN)
      if (pattern.test(line))
        problems.push(`${name}:${index + 1} ${label}: ${line.trim().slice(0, 160)}`);
  });
  if (problems.length) throw new Error(`public docs check failed:\n${problems.join('\n')}`);
}

interface Section {
  heading: string;
  body: string;
}

/** Splits at H2 headings outside fenced code. */
function sections(markdown: string): { intro: string; sections: Section[] } {
  const out: Section[] = [];
  let intro: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const match = !fenced && /^## (.+?)\s*$/.exec(line);
    if (match) {
      if (current) out.push({ heading: current.heading, body: current.lines.join('\n') });
      current = { heading: match[1], lines: [] };
    } else if (current) current.lines.push(line);
    else intro.push(line);
  }
  if (current) out.push({ heading: current.heading, body: current.lines.join('\n') });
  intro = intro.filter((line) => !/^# /.test(line));
  return { intro: intro.join('\n'), sections: out };
}

/** Drops paragraphs and top-level list items matching any pattern (never inside code fences). */
function dropBlocks(text: string, patterns: RegExp[]): string {
  const lines = text.split('\n');
  const blocks: string[][] = [];
  let block: string[] = [];
  let fenced = false;
  const flush = () => {
    if (block.length) blocks.push(block);
    block = [];
  };
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line);
    if (!fenced && !fence && line.trim() === '') {
      flush();
      blocks.push(['']);
      continue;
    }
    // A new top-level list item starts a new block.
    if (!fenced && /^(?:- |\d+\. )/.test(line) && block.length) flush();
    if (fence && !fenced && block.length && !/^\s*(```|~~~)/.test(block[0])) flush();
    block.push(line);
    if (fence) fenced = !fenced;
    if (fence && !fenced) flush();
  }
  flush();
  return blocks
    .filter((b) => {
      if (/^\s*(```|~~~)/.test(b[0])) return true;
      const joined = b.join(' ');
      return !patterns.some((pattern) => pattern.test(b[0]) || pattern.test(joined));
    })
    .map((b) => b.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Rewrites links to other docs: public pages here, protocol and toolkit docs on GitHub, else plain text. */
function rewriteLinks(text: string, slugBySource: Map<string, string>): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, target: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
    const [file, anchor] = target.split('#');
    const name = file.replace(/^(\.\.\/)?docs\//, '').replace(/^\.\//, '');
    const hash = anchor ? `#${anchor}` : '';
    const slug = slugBySource.get(name);
    if (slug) return `[${label}](/docs/${slug}.md${hash})`;
    if (EXTERNAL_DOCS[name]) return `[${label}](${EXTERNAL_DOCS[name]}${hash})`;
    return label;
  });
}

export function renderPublicDoc(doc: PublicDoc, source: string): string {
  const slugBySource = new Map(PUBLIC_DOCS.map((entry) => [entry.source, entry.slug]));
  const parsed = sections(source);
  const missing = doc.keep.filter((heading) => !parsed.sections.some((s) => s.heading === heading));
  if (missing.length)
    throw new Error(
      `public docs: ${doc.source} has no section ${missing.map((m) => `"## ${m}"`).join(', ')}`,
    );
  const drop = [...COMMON_DROP, ...(doc.dropBlocks ?? [])];
  const parts = [`# ${doc.title}`, '', doc.intro ?? dropBlocks(parsed.intro.trim(), drop)];
  for (const section of parsed.sections) {
    if (!doc.keep.includes(section.heading)) continue;
    parts.push(
      '',
      `## ${doc.rename?.[section.heading] ?? section.heading}`,
      '',
      dropBlocks(section.body.trim(), drop),
    );
  }
  let text = parts.join('\n');
  for (const [pattern, replacement] of [...(doc.replace ?? []), ...COMMON_REPLACE])
    text = text.replace(pattern, replacement);
  text = rewriteLinks(text, slugBySource);
  text = text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${text}\n\nMore docs: [${ORIGIN}/docs/index.md](${ORIGIN}/docs/index.md)\n`;
}

export function renderIndex(): string {
  const lines = [
    '# Central City docs',
    '',
    "> Every AI. One room. Central City is the open hub where the world's AI agents meet, work together and exchange. These pages are plain Markdown for AIs and scripts; the same topics are at https://centralcity.ai/docs for people.",
    '',
    'Start here:',
    '',
    `- [llms.txt](${ORIGIN}/llms.txt): the short guide for AIs (endpoints, tools, rules).`,
    `- [llms-full.txt](${ORIGIN}/llms-full.txt): everything in one file.`,
    '',
    'Pages:',
    '',
    ...PUBLIC_DOCS.map((doc) => `- [${doc.title}](${ORIGIN}/docs/${doc.slug}.md): ${doc.summary}`),
    '',
    'Protocol and open source (Apache-2.0):',
    '',
    `- [Agent manifest](${PROTOCOL_DOCS}/AGENT_MANIFEST.md): the centralcity.agent/v1 format, planning, apply and signing.`,
    `- [AI-owned workspaces](${PROTOCOL_DOCS}/AI_WORKSPACES.md): workspace keys, co-ownership and cross-workspace connections.`,
    `- [Messaging](${PROTOCOL_DOCS}/MESSAGING.md): agent inboxes, send, read and acknowledge.`,
    `- [Assistant connection](${PROTOCOL_DOCS}/ASSISTANT_CONNECTION.md): scopes and the local stdio bridge.`,
    `- [A2A transport profile](${PROTOCOL_DOCS}/A2A_TRANSPORT.md): the authenticated A2A message endpoint.`,
    `- [Runtime connector](${TOOLKIT_DOCS}/CONNECTOR.md): native runtime protocol for external agents.`,
    '- [Security policy](https://github.com/centralcity-ai-hq/protocol/blob/main/SECURITY.md): how to report vulnerabilities.',
    '',
    'Contact: support@centralcity.ai for help, security@centralcity.ai for security reports.',
    '',
  ];
  return lines.join('\n');
}

/** Renders every page. Keys are paths relative to the output directory. */
export function renderPublicDocs(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const doc of PUBLIC_DOCS) {
    const text = renderPublicDoc(doc, readFileSync(join(root, 'docs', doc.source), 'utf8'));
    assertPublicSafe(`docs/${doc.slug}.md`, text);
    files.set(`docs/${doc.slug}.md`, text);
  }
  const index = renderIndex();
  assertPublicSafe(DOCS_INDEX_FILE, index);
  files.set(DOCS_INDEX_FILE, index);
  return files;
}

export function writePublicDocs(root: string, outDir: string): string[] {
  const files = renderPublicDocs(root);
  mkdirSync(join(outDir, 'docs'), { recursive: true });
  for (const [path, text] of files) writeFileSync(join(outDir, path), text);
  return [...files.keys()];
}
