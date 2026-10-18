import { useState } from 'react';
import { Check, Plus, ShieldCheck } from 'lucide-react';
import type { ConnectionRequest } from '../../shared/assistant';
import type { Connection, Snapshot } from '../../shared/types';
import { capabilityLabels, ConfirmDialog } from '../components';
import { AvatarColorsContext, useAvatarColors } from '../shell/avatarColor';
import {
  crossNames,
  InviteCard,
  OthersCard,
  RequestsCard,
  UseInviteCard,
  useCrossConnections,
} from '../Connections';
import { activeCount, hasRoute, routeLine } from './model';
import { AgentLabel, CardHead, MoreMenu, Wire } from './parts';
import './agent-permissions.css';

/** Prefill for the New connection sheet ("Let B send work back" opens it reversed). */
export type ConnectionPrefill = { from: string; to: string };

type Confirm =
  | { kind: 'end'; connection: Connection }
  | { kind: 'deny'; item: ConnectionRequest }
  | { kind: 'revoke'; item: ConnectionRequest }
  | null;

const FACTS = [
  'No tools or passwords are shared',
  'Work goes one way only',
  'End any connection at any time',
];

/** Moves focus to a card's heading once a row it came from is gone (after a dialog closed). */
function focusHeading(id: string) {
  window.requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected)
      document.getElementById(id)?.focus({ preventScroll: true });
  });
}

/** Scrolls a card into view and puts focus on its heading (the page header's chips). */
function jumpTo(section: string, heading: string) {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  document
    .getElementById(section)
    ?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  document.getElementById(heading)?.focus({ preventScroll: true });
}

/**
 * Agent permissions v3, "Your agents, your rules": the routes between your own agents (one way
 * each, drawn as a line and said in words), requests from other people waiting for you, your
 * connections with other people, and invites both ways. Every action uses the same calls as
 * before: POST/DELETE /api/connections for your own routes, /api/v2/connections/* for other
 * people (src/Connections.tsx). Styles: ./agent-permissions.css, scoped to .perm3.
 */
export function AgentPermissions({
  snapshot,
  busy,
  hasAgents,
  onNewConnection,
  onSendWork,
  onEndConnection,
  onSeeWork,
  onChanged,
}: {
  snapshot: Snapshot;
  /** An action of the console runs (its buttons wait). */
  busy: boolean;
  hasAgents: boolean;
  onNewConnection: (prefill?: ConnectionPrefill) => void;
  onSendWork: (connectionId: string) => void;
  /**
   * DELETE /api/connections/:id through the console (its message on success). Resolves to the
   * failure ('' when it went through), which the confirm shows instead of the page's banner.
   */
  onEndConnection: (connection: Connection) => Promise<string>;
  /** "See work sent": Research & review. */
  onSeeWork: () => void;
  onChanged: () => void;
}) {
  const cross = useCrossConnections(snapshot.agents, onChanged);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [ending, setEnding] = useState(false);
  // A failed End, Deny or Revoke keeps its confirm open and says why there.
  const [endError, setEndError] = useState('');
  const [crossFailed, setCrossFailed] = useState(false);
  // Every agent keeps its My agents colour: one per agent, oldest first (src/shell/avatarColor.ts).
  const colours = useAvatarColors(
    snapshot.agents.map((agent) => ({ id: agent.id, joinedAt: agent.createdAt })),
  );
  const agentOf = (id: string) => snapshot.agents.find((agent) => agent.id === id);
  const nameOf = (id: string) => agentOf(id)?.name || 'Agent';
  const routes = snapshot.connections;
  const active = activeCount(routes, cross.lists);
  const waiting = cross.lists ? cross.pending.length : 0;

  /** Opens (or, with null, closes) a confirm; a new one starts without the last failure. */
  function ask(next: Confirm) {
    setEndError('');
    setCrossFailed(false);
    setConfirm(next);
  }
  async function endOwn(connection: Connection) {
    setEnding(true);
    setEndError('');
    let failure = '';
    try {
      failure = await onEndConnection(connection);
    } finally {
      setEnding(false);
    }
    if (failure) return setEndError(failure);
    setConfirm(null);
    focusHeading('perm3-own-title');
  }
  async function decideCross(item: ConnectionRequest, decision: 'approve' | 'deny') {
    if (decision === 'deny') setCrossFailed(false);
    const done = await cross.decide(item, decision);
    if (decision === 'deny') {
      if (!done) return setCrossFailed(true);
      setConfirm(null);
    }
    if (done) focusHeading('perm3-others-title');
  }
  async function revokeCross(item: ConnectionRequest) {
    setCrossFailed(false);
    if (!(await cross.revoke(item))) return setCrossFailed(true);
    setConfirm(null);
    focusHeading('perm3-others-title');
  }
  /** The confirmed cross action's failure (the same text its card shows behind the dialog). */
  const crossError = crossFailed ? cross.error?.text : undefined;

  return (
    <AvatarColorsContext.Provider value={colours}>
      <div className="perm3">
        <div className="perm3-topbar">
          <div className="perm3-pill">
            <ShieldCheck size={18} aria-hidden="true" />
            <h1>Agent permissions</h1>
            <span className="perm3-pill-sub">{active} active</span>
          </div>
          {waiting ? (
            <button
              type="button"
              className="perm3-chip"
              aria-label={`Requests ${waiting} waiting`}
              onClick={() => jumpTo('perm3-requests', 'perm3-requests-title')}
            >
              Requests <span className="perm3-chip-n">{waiting}</span>
            </button>
          ) : null}
          {cross.lists ? (
            <button
              type="button"
              className="perm3-chip perm3-hide-phone"
              onClick={() => jumpTo('perm3-invite', 'perm3-invite-title')}
            >
              Invite someone
            </button>
          ) : null}
          <button
            type="button"
            className="perm3-btn"
            data-tone="primary"
            disabled={!hasAgents}
            onClick={() => onNewConnection()}
          >
            <Plus size={16} aria-hidden="true" />
            New connection
          </button>
        </div>

        <div className="perm3-wrap">
          <div className="perm3-hero">
            <p className="perm3-headline">Your agents, your rules</p>
            <p className="perm3-lede">
              Each connection lets one agent send work to another, in one direction. You decide
              every route.
            </p>
            <ul className="perm3-facts" aria-label="What a connection means">
              {FACTS.map((fact) => (
                <li key={fact}>
                  <Check size={15} aria-hidden="true" />
                  {fact}
                </li>
              ))}
            </ul>
          </div>

          <RequestsCard
            cross={cross}
            onApprove={(item) => void decideCross(item, 'approve')}
            onDeny={(item) => ask({ kind: 'deny', item })}
          />

          <section className="perm3-card" id="perm3-own" aria-labelledby="perm3-own-title">
            <CardHead
              id="perm3-own-title"
              title="Between your agents"
              count={routes.length}
              sub="Work travels only the way the line runs."
            />
            {routes.length ? (
              <ul className="perm3-list" aria-label="Routes between your agents">
                {routes.map((connection) => {
                  const fromName = nameOf(connection.fromAgentId);
                  const toName = nameOf(connection.toAgentId);
                  const to = agentOf(connection.toAgentId);
                  const back = hasRoute(routes, connection.toAgentId, connection.fromAgentId);
                  return (
                    <li key={connection.id} className="perm3-route">
                      <div className="perm3-routemain">
                        <div className="perm3-path">
                          <AgentLabel id={connection.fromAgentId} name={fromName} />
                          <Wire />
                          <span className="visually-hidden">sends work to</span>
                          <AgentLabel id={connection.toAgentId} name={toName} />
                        </div>
                        <p className="perm3-oneway">{routeLine(fromName, toName, back)}</p>
                      </div>
                      <div className="perm3-routeacts">
                        {to ? (
                          <span className="perm3-cap">{capabilityLabels[to.capability]}</span>
                        ) : null}
                        <button
                          type="button"
                          className="perm3-btn"
                          data-tone="ghost"
                          disabled={snapshot.paused}
                          aria-label={`Send work from ${fromName} to ${toName}`}
                          onClick={() => onSendWork(connection.id)}
                        >
                          Send work
                        </button>
                        <MoreMenu
                          label={`More for ${fromName} to ${toName}`}
                          items={[
                            ...(back
                              ? []
                              : [
                                  {
                                    label: `Let ${toName} send work back`,
                                    onSelect: () =>
                                      onNewConnection({
                                        from: connection.toAgentId,
                                        to: connection.fromAgentId,
                                      }),
                                  },
                                ]),
                            { label: 'See work sent', onSelect: onSeeWork },
                            {
                              label: 'End connection',
                              danger: true,
                              onSelect: () => ask({ kind: 'end', connection }),
                            },
                          ]}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="perm3-empty" role="status">
                <b>Connect two agents</b>
                Choose which agent asks and which one does the work.
                <div>
                  <button
                    type="button"
                    className="perm3-btn"
                    data-tone="primary"
                    disabled={!hasAgents}
                    onClick={() => onNewConnection()}
                  >
                    <Plus size={16} aria-hidden="true" />
                    New connection
                  </button>
                </div>
              </div>
            )}
          </section>

          <OthersCard cross={cross} onRevoke={(item) => ask({ kind: 'revoke', item })} />

          {cross.lists ? (
            <div className="perm3-duo">
              <InviteCard cross={cross} />
              <UseInviteCard cross={cross} />
            </div>
          ) : null}

          <p className="perm3-foot">
            Names, notes and messages from other people are marked External. Check them before your
            agents act on them.
          </p>
        </div>

        {confirm?.kind === 'end' ? (
          <ConfirmDialog
            title="End connection?"
            confirmLabel={ending ? 'Ending…' : 'End connection'}
            cancelLabel="Keep it"
            busy={ending || busy}
            error={endError || undefined}
            onConfirm={() => void endOwn(confirm.connection)}
            onClose={() => ask(null)}
          >
            <p>
              <strong>{nameOf(confirm.connection.fromAgentId)}</strong> can't send new work to{' '}
              <strong>{nameOf(confirm.connection.toAgentId)}</strong>. Unfinished work between them
              stops.
            </p>
          </ConfirmDialog>
        ) : null}
        {confirm?.kind === 'deny' ? (
          <ConfirmDialog
            title="Deny request?"
            confirmLabel={cross.busy ? 'Denying…' : 'Deny'}
            busy={Boolean(cross.busy)}
            error={crossError}
            onConfirm={() => void decideCross(confirm.item, 'deny')}
            onClose={() => ask(null)}
          >
            <p>
              <strong>{confirm.item.from_agent_name ?? 'Their agent'}</strong> won't be connected to{' '}
              {cross.nameOf(confirm.item.to_agent_id) ?? 'your agent'}. They can ask again after 7
              days.
            </p>
          </ConfirmDialog>
        ) : null}
        {confirm?.kind === 'revoke'
          ? (() => {
              const names = crossNames(confirm.item, cross.nameOf);
              const withdraw = confirm.item.status === 'pending';
              return (
                <ConfirmDialog
                  title={withdraw ? 'Withdraw request?' : 'End connection?'}
                  confirmLabel={
                    cross.busy
                      ? withdraw
                        ? 'Withdrawing…'
                        : 'Ending…'
                      : withdraw
                        ? 'Withdraw'
                        : 'End connection'
                  }
                  cancelLabel="Keep it"
                  busy={Boolean(cross.busy)}
                  error={crossError}
                  onConfirm={() => void revokeCross(confirm.item)}
                  onClose={() => ask(null)}
                >
                  <p>
                    {withdraw ? (
                      <>
                        Your request to connect <strong>{names.mine}</strong> with{' '}
                        <strong>{names.theirs}</strong> is withdrawn.
                      </>
                    ) : (
                      <>
                        No more messages or work can pass between <strong>{names.theirs}</strong>{' '}
                        and <strong>{names.mine}</strong>.
                      </>
                    )}
                  </p>
                </ConfirmDialog>
              );
            })()
          : null}
      </div>
    </AvatarColorsContext.Provider>
  );
}
