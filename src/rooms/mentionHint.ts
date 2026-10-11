import type { Member, RoomMessage } from './api';
import { mentionNamesFor } from './people';
import { autoReplyHref, type MentionAnswering } from '../agents/useAgentAnswering';
import type { PauseFix } from '../agents/v4/settingsActionsModel';

/*
 * "<agent> can’t reply here yet" under your own @mention in a group room, with how to make it
 * answer and the links that do it. Only your own messages and only your own agents: another owner's setup is never asked for (the server answers only for the
 * caller's own agents) and never shown.
 */

const WORD = /[\p{L}\p{N}_]/u;

/**
 * The member names a text @mentions, lowercased: "@Name" at a word start, the longest name first
 * (so "@Lion King" is never "@Lion"), case-insensitive like the server's own matching.
 */
export function mentionedNames(text: string, names: readonly string[]): Set<string> {
  const found = new Set<string>();
  if (!text.includes('@')) return found;
  const sorted = [...new Set(names.map((name) => name.toLowerCase()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const lower = text.toLowerCase();
  for (let at = lower.indexOf('@'); at >= 0; at = lower.indexOf('@', at + 1)) {
    // An email address is not a mention.
    const before = at > 0 ? lower[at - 1]! : '';
    if (before && (WORD.test(before) || '.-+'.includes(before))) continue;
    const rest = lower.slice(at + 1);
    const name = sorted.find((item) => {
      const next = rest[item.length] ?? '';
      return rest.startsWith(item) && !WORD.test(next) && next !== '-';
    });
    if (name) found.add(name);
  }
  return found;
}

const textOf = (message: RoomMessage) =>
  message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n');

/**
 * Your own agents that your own messages @mention, by message: for each agent only your newest
 * message that mentions it, and only while that agent hasn't posted since (once it has, it
 * answered). A mention counts as the room counts it (people.ts mentionNamesFor): written as one
 * of your agents, "@<your own host>" is none. Elric has its own notices and is left out.
 */
export function ownMentionTargets(
  messages: readonly RoomMessage[],
  members: readonly Member[],
): Map<string, Member[]> {
  const mine = members.filter(
    (member) =>
      member.own && (member.kind ?? 'agent') === 'agent' && member.auto_reply?.provider !== 'elric',
  );
  const targets = new Map<string, Member[]>();
  if (!mine.length) return targets;
  const seen = new Set<string>();
  // Newest first: the first own mention of an agent met is its newest one.
  for (let index = messages.length - 1; index >= 0 && seen.size < mine.length; index--) {
    const message = messages[index]!;
    // An agent that posted after your mention has answered (or is answering): no line.
    for (const agent of mine) if (message.sender_agent_id === agent.id) seen.add(agent.id);
    if (
      !message.own ||
      message.auto_reply ||
      (message as { sender_kind?: string }).sender_kind === 'system'
    )
      continue;
    const names = mentionedNames(textOf(message), mentionNamesFor(members, message));
    if (!names.size) continue;
    const hits = mine.filter(
      (agent) =>
        !seen.has(agent.id) &&
        agent.id !== message.sender_agent_id &&
        names.has(agent.name.toLowerCase()),
    );
    for (const agent of hits) seen.add(agent.id);
    if (hits.length) targets.set(message.id, hits);
  }
  return targets;
}

/** One way to fix it: a link into the agent's pane (or the Connect AI view). */
export type MentionFix = { label: string; href: string };
/** The line under your mention: what is wrong, how to make the agent answer, and the links. */
export type MentionCantAnswer = { text: string; actions: MentionFix[] };

/** Connect AI (the console's "Connect your AI" view): connecting an AI app to your agents. */
export const CONNECT_AI_HREF = '/#connect';

/** The fix of a pause (settingsActionsModel autoReplyPause), as a sentence's opening words. */
const FIX_SENTENCE: Record<PauseFix['label'], string> = {
  Resume: 'Resume it',
  'Pick a model': 'Pick a model',
  'Change key': 'Change the key',
  'Add a key': 'Add a key',
};

/**
 * The reason inside pauseCopy's text (src/responder/copy.ts), lowercase-led for "paused: …":
 * "Paused: your OpenAI quota is used up." → "your OpenAI quota is used up"; "Paused after
 * repeated errors from OpenAI." → "repeated errors from OpenAI"; a bare "Paused." → null.
 */
export function pauseReason(text: string): string | null {
  const first = text.split(/(?<=\.)\s+/)[0]!.replace(/\.$/, '');
  const said = /^(?:Paused(?: for \d+ min)?|Off): (.+)$/.exec(first);
  if (said) return said[1]!;
  const after = /^Paused (after .+)$/.exec(first);
  return after ? after[1]!.replace(/^after /, '') : null;
}

/**
 * The line under your mention when your agent can't answer, or null when it can (or the server
 * can't say: nothing is guessed). It says how to make the agent answer and that it can be switched
 * off again; its actions open the agent's own screens (Auto-reply) or Connect AI.
 */
export function mentionCantAnswerLine(
  name: string,
  agentId: string,
  answer: MentionAnswering | null | undefined,
): MentionCantAnswer | null {
  if (!answer || answer.can) return null;
  const autoReply = autoReplyHref(agentId);
  if (answer.auto_reply === 'paused') {
    const reason = answer.pause ? pauseReason(answer.pause.text) : null;
    const fix = answer.pause ? answer.pause.fix : { label: 'Resume' as const, does: 'resume' };
    const why = `${name}’s Auto-reply is paused${reason ? `: ${reason}` : ''}.`;
    if (!fix)
      // A rate limit: nothing to do, it resumes by itself.
      return {
        text: `${why} It resumes by itself, then ${name} answers @mentions again.`,
        actions: [{ label: 'Open Auto-reply', href: autoReply }],
      };
    return {
      text: `${why} ${FIX_SENTENCE[fix.label]} to have ${name} answer @mentions again.`,
      actions: [{ label: fix.label, href: autoReply }],
    };
  }
  if (answer.auto_reply === 'off')
    return {
      text: `${name} can’t reply here because its Auto-reply is off. Turn it on to have ${name} answer @mentions; you can switch it off again at any time.`,
      actions: [{ label: 'Turn on Auto-reply', href: autoReply }],
    };
  return {
    text: `${name} can’t reply here yet. To have ${name} answer @mentions, set up Auto-reply (it replies with an AI model you choose) or connect an AI app to ${name}. You can turn either off again at any time.`,
    actions: [
      { label: 'Set up Auto-reply', href: autoReply },
      { label: 'Connect an AI app', href: CONNECT_AI_HREF },
    ],
  };
}
