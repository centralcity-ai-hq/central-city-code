import { useEffect, useState } from 'react';
import { getAgentAnswering, isAgentId, type AgentAnswering } from '../rooms/api';
import { getSettings, loadModels } from '../responder/api';
import { autoReplyModelName, autoReplyPause, type PauseFix } from './v4/settingsActionsModel';

/** How often the answer is read again while the page is visible (a key added, a runtime up). */
const REFRESH_MS = 30_000;

/**
 * Whether one of your agents can answer now (GET /api/agents/:id/answering), read on mount (visible
 * or not: a page opened in a background tab shows the answer too), every 30 s while visible and
 * when the tab comes back. Null while unknown or when the server can't say: then nothing is shown,
 * never a guess. Without a real id nothing is requested.
 */
export function useAgentAnswering(agentId: string | null | undefined): AgentAnswering | null {
  const [answer, setAnswer] = useState<AgentAnswering | null>(null);
  useEffect(() => {
    setAnswer(null);
    if (!isAgentId(agentId)) return;
    let live = true;
    const load = () =>
      getAgentAnswering(agentId).then(
        (next) => live && setAnswer(next),
        // A failed read keeps what was shown; the next one tries again.
        () => {},
      );
    const read = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load();
    const timer = window.setInterval(read, REFRESH_MS);
    document.addEventListener('visibilitychange', read);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [agentId]);
  return answer;
}

/** Why an agent's Auto-reply is paused and its one fix (settingsActionsModel autoReplyPause). */
export type AnsweringPause = { text: string; fix: PauseFix | null };
/** An answer for a mention line: with a paused Auto-reply, why it is paused (when readable). */
export type MentionAnswering = AgentAnswering & { pause?: AnsweringPause };

/**
 * useAgentAnswering for several of your agents at once (the ones your group-room @mentions name),
 * read on the same schedule: at once when the agents change (visible or not), then every 30 s
 * while visible and when the tab comes back. A paused Auto-reply also reads its settings (GET
 * /api/agents/:id/responder) for the reason and its fix. An agent missing from the answer is
 * unknown: nothing is shown for it. Ids that aren't real ids are never asked about.
 */
export function useAgentsAnswering(
  agentIds: readonly (string | null | undefined)[],
): ReadonlyMap<string, MentionAnswering> {
  const key = [...new Set(agentIds.filter(isAgentId))].sort().join(',');
  const [answers, setAnswers] = useState<ReadonlyMap<string, MentionAnswering>>(() => new Map());
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    // Agents no longer asked about drop out; the others keep their answer until the next read.
    setAnswers((current) => {
      const kept = new Map([...current].filter(([id]) => ids.includes(id)));
      return kept.size === current.size ? current : kept;
    });
    if (!ids.length) return;
    let live = true;
    const withPause = async (id: string, next: AgentAnswering): Promise<MentionAnswering> => {
      if (next.can || next.auto_reply !== 'paused') return next;
      try {
        return { ...next, pause: autoReplyPause(await getSettings(id)) };
      } catch {
        // The settings can't be read: the line says it is paused, without a reason.
        return next;
      }
    };
    const load = () => {
      for (const id of ids)
        getAgentAnswering(id)
          .then((next) => (next ? withPause(id, next) : null))
          .then(
            (next) =>
              live &&
              setAnswers((current) => {
                const updated = new Map(current);
                if (next) updated.set(id, next);
                else updated.delete(id);
                return updated;
              }),
            // A failed read keeps what was shown; the next one tries again.
            () => {},
          );
    };
    const read = () => {
      if (document.visibilityState === 'visible') load();
    };
    load();
    const timer = window.setInterval(read, REFRESH_MS);
    document.addEventListener('visibilitychange', read);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [key]);
  return answers;
}

/**
 * The private chat's line when the agent can't answer (RoomView), or null when it can (or nobody
 * knows): a paused Auto-reply says so; otherwise it says how to make the agent answer.
 */
export function cantAnswerLine(
  name: string,
  answer: AgentAnswering | null,
): { text: string; action: string } | null {
  if (!answer || answer.can) return null;
  if (answer.auto_reply === 'paused')
    return { text: `${name}'s Auto-reply is paused.`, action: 'Open Auto-reply' };
  return { text: `${name} can't answer yet.`, action: 'Set up Auto-reply' };
}

/**
 * The agent pane's Auto-reply row as a status (AgentPane): a dot, a hint under the label, and on
 * the right either an action word or a quiet value. `tone` null is the plain row (label only):
 * the answer is unknown (or the agent is removed), so nothing is guessed.
 */
export type AutoReplyRowState =
  | { tone: null }
  | { tone: 'off' | 'paused'; hint: string; action: 'Set up' | 'Resume' | 'Fix' }
  | { tone: 'on'; hint: string; value: 'On' | 'Off' | 'Paused' };

/**
 * What the Auto-reply row says, from the answering route (and, when Auto-reply answers, the chosen
 * model's name if it could be read):
 * - can't answer, Auto-reply not set up or off: "<name> can't reply yet", Set up;
 * - can't answer, Auto-reply paused: "<name> won't reply", Resume (the row opens the screen);
 * - answers through Auto-reply: "<name> replies with <model>" (or "<name> replies"), On;
 * - answers through a connected AI app (not a scripted runtime), Auto-reply not on:
 *   "<name> replies through an AI app", Off;
 * - unknown: the plain row.
 * A CC agent's scripted runtime (no AI model) never replies, so with Auto-reply not on it reads
 * as can't reply yet even if a server counted it.
 */
export function autoReplyRowState(
  name: string,
  answer: AgentAnswering | null,
  modelLabel?: string | null,
): AutoReplyRowState {
  if (!answer) return { tone: null };
  const scriptedOnly = answer.by === 'runtime' && answer.scripted === true;
  if (!answer.can || scriptedOnly) {
    if (answer.auto_reply === 'paused')
      return { tone: 'paused', hint: `${name} won't reply`, action: 'Resume' };
    // Auto-reply is set up and on, yet it can't answer now (a key or limit problem): fix it, not
    // set it up again.
    if (answer.auto_reply === 'on')
      return { tone: 'off', hint: `${name} can't reply right now`, action: 'Fix' };
    return { tone: 'off', hint: `${name} can't reply yet`, action: 'Set up' };
  }
  if (answer.auto_reply === 'on') {
    const model = modelLabel?.trim();
    return {
      tone: 'on',
      hint: model ? `${name} replies with ${model}` : `${name} replies`,
      value: 'On',
    };
  }
  // Replies through a connected AI app; the value is Auto-reply's own state (Paused or Off).
  if (answer.by === 'runtime')
    return {
      tone: 'on',
      hint: `${name} replies through an AI app`,
      value: answer.auto_reply === 'paused' ? 'Paused' : 'Off',
    };
  return { tone: null };
}

/**
 * The name of the model Auto-reply answers with (GET /api/agents/:id/responder and the model
 * list), read only while `read` is true (Auto-reply answers and the row is shown) and again each
 * time it turns true. Null until read, or when either read fails: the row then just says it replies.
 */
export function useAutoReplyModel(
  agentId: string | null | undefined,
  read: boolean,
): string | null {
  const [label, setLabel] = useState<{ agentId: string; label: string | null } | null>(null);
  useEffect(() => {
    if (!read || !isAgentId(agentId)) return;
    let live = true;
    Promise.all([getSettings(agentId), loadModels()]).then(
      ([settings, models]) =>
        live && setLabel({ agentId, label: autoReplyModelName(settings, models ?? []) }),
      () => live && setLabel({ agentId, label: null }),
    );
    return () => {
      live = false;
    };
  }, [agentId, read]);
  return label && label.agentId === agentId ? label.label : null;
}

/** The address of an agent's Auto-reply screen in My agents (read by MyAgentsV2). */
export const autoReplyHref = (agentId: string) =>
  `/agents#agent=${encodeURIComponent(agentId)}:autoreply`;
