import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CircleHelp, LoaderCircle, X } from 'lucide-react';
import type { Agent, Snapshot } from '../../shared/types';
import { mergeAgents } from '../agents/agentPages';
import { readAgentsById, searchLiveAgents } from '../agents/ownAgents';
import { useAgentPicker } from '../agents/useAgentPicker';
import { api } from '../api';
import { capabilityLabels } from '../components';
import { AvatarColorsContext, useAvatarColors } from '../shell/avatarColor';
import { useDialogFocus } from '../rooms/useDialogFocus';
import { connectionPlan, liveAgents } from './model';
import { AgentLabel, Wire } from './parts';
import './agent-permissions.css';

/**
 * The New connection sheet: which agent sends work and which one does it, the route drawn and
 * said in plain words, and "Also let it send work back", which adds the second, reversed route
 * with a second POST /api/connections (each route stays one way; nothing else changes on the
 * server). Opened from Agent permissions, prefilled reversed by "Let B send work back".
 */
export function ConnectionSheet({
  snapshot,
  initialFrom,
  initialTo,
  onClose,
  onCreated,
  onPartial,
}: {
  snapshot: Snapshot;
  initialFrom?: string;
  initialTo?: string;
  onClose: () => void;
  onCreated: (message: string) => Promise<void>;
  /** The first route was made, the way back was not: refresh so the page shows the first. */
  onPartial: () => Promise<void>;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // A paged workspace (src/agents/agentPages.ts) carries only some agents: the prefilled ones are
  // read by id, and each side searches every agent.
  const paged = Boolean(snapshot.agentsPage);
  const [extra, setExtra] = useState<Agent[]>([]);
  const candidates = liveAgents(mergeAgents(snapshot.agents, extra));
  const [from, setFrom] = useState(initialFrom || candidates[0]?.id || '');
  const [to, setTo] = useState(
    initialTo ||
      candidates.find((agent) => agent.id !== (initialFrom || candidates[0]?.id))?.id ||
      '',
  );
  const [both, setBoth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => {
    if (!busy) onClose();
  };
  useDialogFocus(dialog, close);
  const missing = [initialFrom, initialTo].filter(
    (agentId): agentId is string =>
      Boolean(agentId) && !snapshot.agents.some((agent) => agent.id === agentId),
  );
  const missingKey = paged ? missing.join(',') : '';
  useEffect(() => {
    if (!missingKey) return;
    const controller = new AbortController();
    readAgentsById(missingKey.split(','), controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) setExtra(found);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [missingKey]);
  const search = paged ? searchLiveAgents : null;
  const senders = useAgentPicker(candidates, search, [from], { className: 'perm3-search' });
  const workers = useAgentPicker(candidates, search, [to], { className: 'perm3-search' });
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, []);
  const colours = useAvatarColors(
    snapshot.agents.map((agent) => ({ id: agent.id, joinedAt: agent.createdAt })),
  );
  const sender = senders.known.get(from);
  const worker = workers.known.get(to);
  const plan = connectionPlan(snapshot.connections, from, to, both);
  const fromName = sender?.name ?? 'This agent';
  const toName = worker?.name ?? 'the other agent';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (plan.blocked || busy) return;
    setBusy(true);
    setError('');
    let made = 0;
    try {
      for (const route of plan.creates) {
        await api('/api/connections', { fromAgentId: route.from, toAgentId: route.to });
        made += 1;
      }
      await onCreated(
        both
          ? `Connected both ways. ${fromName} and ${toName} can send work to each other.`
          : 'Connection created.',
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "These agents couldn't be connected.";
      if (made) {
        setError(`${fromName} can now send work to ${toName}, but the way back failed: ${reason}`);
        await onPartial();
      } else setError(reason);
    } finally {
      setBusy(false);
    }
  }

  const options = (agents: readonly Agent[] | null) =>
    (agents ?? []).map((agent) => (
      <option key={agent.id} value={agent.id}>
        {agent.name}
      </option>
    ));
  return (
    <div
      className="perm3-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className="perm3-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="perm3-sheethead">
          <h2 id={`${id}-title`}>New connection</h2>
          <button
            type="button"
            className="perm3-round"
            aria-label="Close"
            disabled={busy}
            onClick={close}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <AvatarColorsContext.Provider value={colours}>
          <form className="perm3-sheetbody" onSubmit={(event) => void submit(event)}>
            {candidates.length < 2 ? (
              <p className="perm3-warn">
                <CircleHelp size={16} aria-hidden="true" />
                Add at least two agents to create a connection.
              </p>
            ) : null}
            <div className="perm3-pair">
              <div>
                <label className="perm3-label" htmlFor={`${id}-from`}>
                  Sends work
                </label>
                <select
                  id={`${id}-from`}
                  className="perm3-field"
                  autoFocus
                  disabled={busy}
                  required
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                >
                  <option value="" disabled>
                    Choose an agent
                  </option>
                  {options(senders.agents)}
                </select>
                {senders.field}
              </div>
              <div>
                <label className="perm3-label" htmlFor={`${id}-to`}>
                  Does the work
                </label>
                <select
                  id={`${id}-to`}
                  className="perm3-field"
                  disabled={busy}
                  required
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                >
                  <option value="" disabled>
                    Choose an agent
                  </option>
                  {options(workers.agents)}
                </select>
                {workers.field}
              </div>
            </div>
            {sender && worker ? (
              <div className="perm3-path perm3-preview" aria-hidden="true">
                <AgentLabel
                  id={sender.id}
                  name={sender.name}
                  sub={capabilityLabels[sender.capability]}
                />
                <Wire />
                <AgentLabel
                  id={worker.id}
                  name={worker.name}
                  sub={capabilityLabels[worker.capability]}
                />
              </div>
            ) : null}
            {/* The route in words and any reason it can't be made, read out as they change. */}
            <div className="perm3-live" aria-live="polite">
              {sender && worker && !plan.same ? (
                <p className="perm3-say">
                  {both ? (
                    <>
                      <b>{sender.name}</b> and <b>{worker.name}</b> can send work to each other.
                    </>
                  ) : plan.back ? (
                    <>
                      <b>{sender.name}</b> can send work to <b>{worker.name}</b>. {worker.name} can
                      already send work to {sender.name}.
                    </>
                  ) : (
                    <>
                      <b>{sender.name}</b> can send work to <b>{worker.name}</b>. {worker.name}{' '}
                      can't send work back.
                    </>
                  )}
                </p>
              ) : null}
              {plan.same ? (
                <p className="perm3-warn">Pick two different agents.</p>
              ) : plan.forward ? (
                <p className="perm3-warn">
                  {both && plan.back
                    ? `${fromName} and ${toName} can already send work to each other.`
                    : both
                      ? `${fromName} can already send work to ${toName}. Only the way back is added.`
                      : `${fromName} can already send work to ${toName}.`}
                </p>
              ) : null}
            </div>
            <label className="perm3-check">
              <input
                type="checkbox"
                checked={both}
                disabled={busy}
                onChange={(event) => setBoth(event.target.checked)}
              />
              Also let it send work back
            </label>
            {error ? (
              <p className="perm3-alert" role="alert">
                {error}
              </p>
            ) : null}
            <div className="perm3-sheetacts">
              <button
                type="button"
                className="perm3-btn"
                data-tone="ghost"
                disabled={busy}
                onClick={close}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="perm3-btn"
                data-tone="primary"
                disabled={busy || candidates.length < 2 || plan.blocked}
              >
                {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>
        </AvatarColorsContext.Provider>
      </div>
    </div>
  );
}
