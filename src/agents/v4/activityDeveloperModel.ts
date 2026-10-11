import type {
  Agent,
  AgentActivityItem,
  AgentActivityPage,
  Capability,
} from '../../../shared/types';
import { creatorLabel } from '../../components';

/*
 * My agents v4, Activity and Developer details of one agent (docs/design/my-agents-v4-mockup.html).
 * Pure, so the screens stay thin and tests/v4-activity-developer.test.ts covers every rule here.
 */

/* ---------- Activity ---------- */

/** Items per page of GET /api/agents/:id/activity (the server's default; it allows up to 100). */
export const ACTIVITY_PAGE = 50;

/** The feed's path: the newest page, or the page older than `before` (the server's cursor). */
export function activityPath(agentId: string, before?: string | null): string {
  const query = `limit=${ACTIVITY_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
  return `/api/agents/${encodeURIComponent(agentId)}/activity?${query}`;
}

/** The items loaded so far and the cursor for the next older page (null: nothing older). */
export type ActivityFeed = { items: AgentActivityItem[]; nextBefore: string | null };

/** The server's own sort key (server/activity.ts), so merged pages keep its order. */
export const itemKey = (item: AgentActivityItem) => `${item.kind}:${item.id}`;

function newerFirst(a: AgentActivityItem, b: AgentActivityItem): number {
  const at = Date.parse(b.at) - Date.parse(a.at);
  if (at) return at;
  const ka = itemKey(a),
    kb = itemKey(b);
  return ka < kb ? 1 : ka > kb ? -1 : 0;
}

/**
 * Items from a fresh read joined with those already shown: one line per item (the fresh copy
 * wins, so a run's status moves on), newest first.
 */
export function mergeItems(
  shown: readonly AgentActivityItem[],
  fresh: readonly AgentActivityItem[],
): AgentActivityItem[] {
  const byKey = new Map<string, AgentActivityItem>();
  for (const item of shown) byKey.set(itemKey(item), item);
  for (const item of fresh) byKey.set(itemKey(item), item);
  return [...byKey.values()].sort(newerFirst);
}

/** A newer re-read of the first page: its items join the feed, the older cursor stays. */
export function refreshFeed(feed: ActivityFeed | null, page: AgentActivityPage): ActivityFeed {
  if (!feed) return { items: mergeItems([], page.items), nextBefore: page.nextBefore };
  return { items: mergeItems(feed.items, page.items), nextBefore: feed.nextBefore };
}

/** An older page ("Show older"): its items join the feed and its cursor replaces the old one. */
export function appendPage(feed: ActivityFeed, page: AgentActivityPage): ActivityFeed {
  return { items: mergeItems(feed.items, page.items), nextBefore: page.nextBefore };
}

const pad = (n: number) => String(n).padStart(2, '0');
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "07:38": the local clock time, 24-hour. */
export function clock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A line's day key (local midnight); the day groups follow it. */
export function dayOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? startOfDay(t) : Number.NaN;
}

/** The day heading: "Today", "Yesterday", else the date ("Oct 8"; with the year when not this year). */
export function dayLabel(day: number, now = Date.now(), locale?: string): string {
  if (!Number.isFinite(day)) return '';
  const today = startOfDay(now);
  if (day === today) return 'Today';
  if (day === startOfDay(today - 1)) return 'Yesterday';
  const sameYear = new Date(day).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(day);
}

/** Shorter than this ago, the line shows hours ("1 h"); older lines show their clock time. */
const HOURS_FOR_MS = 3 * 3_600_000;

/**
 * The time under a line, as the mockup writes it: "now", "4 min", "1 h" for the last few hours of
 * today, else the clock time ("07:38", "18:20"); the day heading above says which day.
 */
export function activityTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const ms = now - t;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  if (ms < HOURS_FOR_MS && t >= startOfDay(now)) return `${Math.floor(minutes / 60)} h`;
  return clock(iso);
}

export type ActivityTone = 'ok' | 'warn' | 'bad';

/** One line of the Activity screen. */
export type ActivityRow = {
  key: string;
  at: string;
  title: string;
  /** The status pill of a run ("Done", "Running", "Failed"); events have none. */
  status: { tone: ActivityTone; label: string } | null;
};

const RUN_STATUS: Record<
  Extract<AgentActivityItem, { kind: 'run' }>['status'],
  { tone: ActivityTone; label: string }
> = {
  done: { tone: 'ok', label: 'Done' },
  running: { tone: 'warn', label: 'Running' },
  failed: { tone: 'bad', label: 'Failed' },
};

/**
 * The names an event line may use, by ID: the owner's agents (their snapshot) and the rooms they
 * see (GET /api/rooms). Nothing else: never another owner's data. `ownerAgents` says whether the
 * owner's agent list was read; only then is an agent missing from it known to be another owner's.
 */
export type ActivityNames = {
  agents: ReadonlyMap<string, string>;
  rooms: ReadonlyMap<string, string>;
  ownerAgents: boolean;
};

/** Before (or without) any names: every ID reads as "an agent", "a room". */
export const NO_NAMES: ActivityNames = { agents: new Map(), rooms: new Map(), ownerAgents: false };

/**
 * The lookup from what the screen read. `agents` is null when the owner snapshot could not be
 * read; an empty or blank name counts as no name.
 */
export function activityNames(
  agents: readonly { id: string; name: string }[] | null,
  rooms: readonly { id: string; name: string }[] | null,
): ActivityNames {
  const byId = (items: readonly { id: string; name: string }[] | null) => {
    const map = new Map<string, string>();
    for (const item of items ?? []) {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (typeof item.id === 'string' && name) map.set(item.id.toLowerCase(), name);
    }
    return map;
  };
  return { agents: byId(agents), rooms: byId(rooms), ownerAgents: agents !== null };
}

/** The names with the screen's own agent in them (known even when the snapshot read failed). */
export function withAgent(
  names: ActivityNames,
  agent: { id: string; name: string },
): ActivityNames {
  const name = agent.name.trim();
  if (!name) return names;
  const agents = new Map(names.agents);
  agents.set(agent.id.toLowerCase(), name);
  return { ...names, agents };
}

const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const HAS_ID = new RegExp(UUID, 'i');
/** Words that already say which one ("your room <id>"): the noun stays after them. */
const DETERMINER = 'a|an|another|any|each|every|her|his|its|my|our|that|the|their|this|which|your';
const POSSESSIVE = /^(?:her|his|its|my|our|their|your)$/i;
/** "agent <id>" / "room <id>", with the word before when it is a determiner. */
const NOUN_ID = new RegExp(
  String.raw`\b(?:(${DETERMINER})\s+)?(agent|room)\s+(${UUID})\b((?:\s+of another owner)\b)?`,
  'gi',
);
/** A parenthesis that only holds an ID ("(job <id>)"): it says nothing to a person. */
const ID_ONLY_PARENS = new RegExp(String.raw`\s*\((?:[a-z]+\s+)?${UUID}\)`, 'gi');
/** Any other ID, with the word before it. */
const OTHER_ID = new RegExp(String.raw`(?:\b([a-z]+)\s+)?\b${UUID}\b`, 'gi');
/** Words an ID can follow that do not say what it is ("with <id>"): the ID becomes "an item". */
const PREPOSITION = /^(?:about|and|as|at|by|for|from|in|into|of|on|or|to|via|with)$/i;

const capital = (word: string) => /^[A-Z]/.test(word);

/**
 * An event line without raw IDs (the server's sentences, old rows included, may carry them):
 * "Agent <id>" becomes the agent's name when the owner has it, else "An agent of another owner"
 * (just "An agent" when the owner's agents could not be read); "Room <id>" becomes
 * "Room <name>" when the owner sees the room, else "A room"; after a determiner ("your room <id>")
 * only the ID goes or turns into the name. Any other ID goes: the noun before it stays
 * ("Result <id>" → "Result"), and one without a noun reads "an item". Sentence case is kept.
 */
export function nameIds(text: string, names: ActivityNames = NO_NAMES): string {
  if (!HAS_ID.test(text)) return text;
  // Names go in as placeholders, so an ID inside a name is never touched by the later steps.
  const kept: string[] = [];
  const keep = (name: string) => `\u0000${kept.push(name) - 1}\u0000`;
  let out = text.replace(
    NOUN_ID,
    (_match, det: string | undefined, noun: string, id: string, another: string | undefined) => {
      const lead = det ? `${det} ${noun}` : '';
      if (noun.toLowerCase() === 'room') {
        const name = names.rooms.get(id.toLowerCase());
        if (name) return `${lead || noun} ${keep(name)}${another ?? ''}`;
        return `${lead || (capital(noun) ? 'A room' : 'a room')}${another ?? ''}`;
      }
      const name = names.agents.get(id.toLowerCase());
      if (name) return `${det ? `${lead} ` : ''}${keep(name)}${another ?? ''}`;
      // Not one of the owner's agents: another owner's (said once, even if the text says it too).
      const theirs = names.ownerAgents ? ' of another owner' : (another ?? '');
      if (det) return POSSESSIVE.test(det) ? `${lead}${another ?? ''}` : `${lead}${theirs}`;
      return `${capital(noun) ? 'An agent' : 'an agent'}${theirs}`;
    },
  );
  out = out.replace(ID_ONLY_PARENS, '');
  out = out.replace(OTHER_ID, (_match, word: string | undefined, offset: number, all: string) => {
    if (word && !PREPOSITION.test(word)) return word;
    const start = !all.slice(0, offset).trim() || /[.!?]\s*$/.test(all.slice(0, offset));
    const item = !word && start ? 'An item' : 'an item';
    return word ? `${word} ${item}` : item;
  });
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim();
  return out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => kept[Number(index)]!);
}

/**
 * What a line says. An event: the server's own sentence, with names for the IDs in it (nameIds).
 * A run: "Run: <what>", with the other agent when it is named here ("for" when this agent did the
 * work, "by" when it asked for it).
 */
export function activityRow(item: AgentActivityItem, names: ActivityNames = NO_NAMES): ActivityRow {
  if (item.kind === 'event')
    return { key: itemKey(item), at: item.at, title: nameIds(item.text, names), status: null };
  const who = item.counterpart.name;
  const title = who
    ? `Run: ${item.capability} ${item.role === 'provider' ? 'for' : 'by'} ${who}`
    : `Run: ${item.capability}`;
  return { key: itemKey(item), at: item.at, title, status: RUN_STATUS[item.status] };
}

export type ActivityDay = { day: number; label: string; rows: ActivityRow[] };

/** The feed in day groups, newest day first, each day's lines newest first. */
export function groupByDay(
  items: readonly AgentActivityItem[],
  now = Date.now(),
  locale?: string,
  names: ActivityNames = NO_NAMES,
): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const item of items) {
    const day = dayOf(item.at);
    if (!Number.isFinite(day)) continue;
    let group = days[days.length - 1];
    if (!group || group.day !== day) {
      group = { day, label: dayLabel(day, now, locale), rows: [] };
      days.push(group);
    }
    group.rows.push(activityRow(item, names));
  }
  return days;
}

/* ---------- Developer details ---------- */

/** The agent fields Developer details reads from the owner snapshot (GET /api/snapshot). */
export type DeveloperAgent = Pick<
  Agent,
  | 'id'
  | 'capability'
  | 'mode'
  | 'createdAt'
  | 'revokedAt'
  | 'manifestName'
  | 'revision'
  | 'createdBy'
  | 'parentAgentId'
  | 'claimedAt'
> & { credentialHint?: string | null; description?: string };

/** "3261ccd0…aa77c": the mockup's shortened ID (the whole one is copied). */
export function shortAgentId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-5)}` : id;
}

/** "Does": the mockup's words for what the agent does. */
export const DOES: Record<Capability, string> = {
  research: 'Research',
  extract: 'Extract',
  verify: 'Verify',
};

/** "Oct 10, 07:19": when the agent was created, local time. */
export function createdLabel(iso: string, locale?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(t);
  return `${date}, ${clock(iso)}`;
}

/** The signed Agent Card, served for manifest agents that are not revoked. */
export function agentCardPath(id: string): string {
  return `/a2a/${encodeURIComponent(id)}/.well-known/agent-card.json`;
}

export type DeveloperView = {
  id: string;
  shortId: string;
  does: string;
  /** "winry-70845c · v1", only for agents applied from a manifest. */
  template: string | null;
  created: string;
  /** Who made it: "You", "Your AI", "A connected AI app", "An AI app · claimed", … (creatorLabel). */
  createdBy: string;
  /** The agent it was created under, whose removal also removes this one; null for none. */
  createdUnder: string | null;
  /** What the owner or the creating AI wrote about it; null when nothing was. */
  about: string | null;
  /** The Agent Card link, only when the server serves one. */
  cardPath: string | null;
  /** The masked key ("…a91f"), only when the server kept a hint. */
  key: string | null;
  /** Only agents that run elsewhere have a key to rotate (the server refuses the rest). */
  canRotate: boolean;
};

/**
 * creatorLabel's words without its own "Created by" (the row's label says it): "Your AI" and so on,
 * and the parent's name apart, as its own row.
 */
function origin(
  agent: DeveloperAgent,
  nameOf: (id: string) => string | undefined,
): { createdBy: string; createdUnder: string | null } {
  const by = creatorLabel({ ...agent, parentAgentId: null }, nameOf).replace(/^Created by /, '');
  return {
    createdBy: by.charAt(0).toUpperCase() + by.slice(1),
    createdUnder: agent.parentAgentId
      ? creatorLabel(agent, nameOf).replace(/^Created under /, '')
      : null,
  };
}

export function developerView(
  agent: DeveloperAgent,
  locale?: string,
  /** Names an agent of the same workspace (the parent); undefined when it isn't listed. */
  nameOf: (id: string) => string | undefined = () => undefined,
): DeveloperView {
  const live = !agent.revokedAt;
  return {
    id: agent.id,
    shortId: shortAgentId(agent.id),
    does: DOES[agent.capability] ?? agent.capability,
    template: agent.manifestName ? `${agent.manifestName} · v${agent.revision ?? 1}` : null,
    created: createdLabel(agent.createdAt, locale),
    ...origin(agent, nameOf),
    about: agent.description?.trim() || null,
    cardPath: agent.manifestName && live ? agentCardPath(agent.id) : null,
    key: agent.credentialHint || null,
    canRotate: agent.mode === 'external' && live,
  };
}
