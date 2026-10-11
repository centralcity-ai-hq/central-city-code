import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { api } from './api';
import {
  AppIcon,
  CodeLine,
  CONNECT_APPS,
  ConnectSurface,
  ModeSwitch,
  connectPanels,
  connectTarget,
  nextApp,
  type AppId,
  type Mode,
} from './Connect';
import { activeGrants, connectedSince } from './connect/connectedApps';
import { useInviteHref } from './shell/navigation';
import { CHATGPT_ADMIN_NOTE, ROOM_INVITE_CLIENTS } from './shell/roomInvite';
import type { AssistantGrant } from '../shared/assistant';
import './connect.css';
import './agents/v4/agent-pane.css';
import './connect-app.css';

/** What the address row says for each mode. */
const MODE_ROW: Record<Mode, { title: string; detail: string }> = {
  workspace: {
    title: 'Signs in to your account',
    detail: 'Your AI connects as you. You choose what it may do.',
  },
  open: {
    title: 'Never signs in',
    detail:
      'Your AI joins rooms from invite links, or creates an AI workspace with agents you claim later. It can’t see your account.',
  },
};

/**
 * The AI apps that finished signing in to this account (GET /api/assistant-access), still active.
 * Null until loaded; a failed load counts as none here (Settings → Connected apps reports errors
 * and retries), so the way there is still shown.
 */
function useConnectedApps() {
  const [grants, setGrants] = useState<AssistantGrant[] | null>(null);
  useEffect(() => {
    let current = true;
    void api<{ grants: AssistantGrant[] }>('/api/assistant-access')
      .then((value) => {
        if (current) setGrants(activeGrants(value.grants));
      })
      .catch(() => {
        if (current) setGrants([]);
      });
    return () => {
      current = false;
    };
  }, []);
  return grants;
}

/**
 * "Connect AI" inside the signed-in workspace (the approved v4 design, on the v4 row tokens of
 * src/agents/v4/agent-pane.css): the server address with its mode switch, the AI apps as rows (a
 * vertical tab list) with the chosen app's steps beside them (below on narrow screens), and the apps
 * already connected to this account. The address, modes and steps are the public page's
 * (src/Connect.tsx), so both always say the same thing. Opening an app never implies a verified
 * connection: only an app that finished signing in is listed under Connected.
 */
export function ConnectAIApp({
  onOpenAgents,
  onOpenConnectedApps,
  connectedAppsLabel,
}: {
  onOpenAgents: () => void;
  onOpenConnectedApps: () => void;
  /** Where connected apps are managed in this shell, e.g. "Settings → Connected apps". */
  connectedAppsLabel: string;
}) {
  const [mode, setMode] = useState<Mode>('workspace');
  const [app, setApp] = useState<AppId>('vscode');
  const rows = useRef<Partial<Record<AppId, HTMLButtonElement | null>>>({});
  const open = mode === 'open';
  const { local, endpoint, serverName } = connectTarget(open);
  const panels = connectPanels({ open, endpoint, serverName, local });
  const inviteHref = useInviteHref();
  const connected = useConnectedApps();
  const now = Date.now();

  function onRowKey(event: KeyboardEvent<HTMLButtonElement>) {
    const next = nextApp(app, event.key);
    if (!next) return;
    event.preventDefault();
    setApp(next);
    rows.current[next]?.focus();
  }

  return (
    <ConnectSurface.Provider value="app">
      <div className="ap4 cx4">
        <div className="cx4-grid">
          <section className="cx4-address" aria-labelledby="cx4-address-title">
            <h2 id="cx4-address-title" className="cx4-sec">
              Server address
            </h2>
            <div className="ap4-group">
              <div className="cx4-code">
                <CodeLine value={endpoint} what="MCP server address" />
              </div>
              <div className="cx4-mode">
                <div className="ap4-k" aria-live="polite">
                  <b>{MODE_ROW[mode].title}</b>
                  <small>{MODE_ROW[mode].detail}</small>
                </div>
                <ModeSwitch
                  className="cx4-seg"
                  name="cx4-mode"
                  mode={mode}
                  onChange={setMode}
                  labels={{ workspace: 'Account', open: 'No account' }}
                />
              </div>
            </div>
          </section>

          <section className="cx4-apps" aria-labelledby="cx4-apps-title">
            <h2 id="cx4-apps-title" className="cx4-sec">
              Choose your AI
            </h2>
            <div
              className="ap4-group"
              role="tablist"
              aria-orientation="vertical"
              aria-labelledby="cx4-apps-title"
            >
              {CONNECT_APPS.map((item) => (
                <button
                  key={item.id}
                  ref={(element) => {
                    rows.current[item.id] = element;
                  }}
                  type="button"
                  role="tab"
                  className="ap4-row cx4-row"
                  id={`cv2-tab-${item.id}`}
                  aria-controls={`cv2-panel-${item.id}`}
                  aria-selected={app === item.id}
                  aria-label={item.name}
                  aria-describedby={`cv2-kind-${item.id}`}
                  tabIndex={app === item.id ? 0 : -1}
                  onClick={() => setApp(item.id)}
                  onKeyDown={onRowKey}
                >
                  <AppIcon app={item} />
                  <span className="ap4-k">
                    <b>{item.name}</b>
                    <small id={`cv2-kind-${item.id}`}>{item.kind}</small>
                  </span>
                  <ChevronRight className="ap4-chev" size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>

          <div className="cx4-steps">
            {CONNECT_APPS.map((item) => (
              <div
                key={item.id}
                role="tabpanel"
                id={`cv2-panel-${item.id}`}
                aria-labelledby={`cv2-tab-${item.id}`}
                className="cx4-panel"
                tabIndex={0}
                hidden={app !== item.id}
              >
                <div className="cx-panel-head">
                  <AppIcon app={item} decorative />
                  <h3>Connect {item.name}</h3>
                  <span className="cx-pill">{item.kind}</span>
                </div>
                {panels[item.id]}
              </div>
            ))}
          </div>

          {connected?.length ? (
            <section className="cx4-connected" aria-labelledby="cx4-connected-title">
              <h2 id="cx4-connected-title" className="cx4-sec">
                Connected
              </h2>
              <ul className="ap4-group" role="list">
                {connected.map((grant) => (
                  <li key={grant.id}>
                    <button
                      type="button"
                      className="ap4-row cx4-row"
                      onClick={onOpenConnectedApps}
                      aria-label={`Manage ${grant.label}, ${connectedSince(grant.createdAt, now).toLowerCase()}, in ${connectedAppsLabel}`}
                    >
                      <span className="ap4-dot cx4-dot" aria-hidden="true" />
                      <span className="ap4-k">
                        <b>{grant.label}</b>
                        <small>{connectedSince(grant.createdAt, now)}</small>
                      </span>
                      <span className="ap4-v">Manage</span>
                      <ChevronRight className="ap4-chev" size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : connected ? (
            <p className="cx4-quiet cx4-connected">
              Apps you connect are listed here once they finish signing in.{' '}
              <button type="button" className="cx4-link" onClick={onOpenConnectedApps}>
                Manage connected apps
              </button>
            </p>
          ) : null}

          <section className="cx4-more" aria-labelledby="cx4-more-title">
            <h2 id="cx4-more-title" className="cx4-sec">
              After connecting
            </h2>
            <div className="ap4-group">
              <a className="ap4-row cx4-row" href={inviteHref}>
                <span className="ap4-k">
                  <b>Invite your AI</b>
                  <small>Copy a room’s invite link and paste it into your AI.</small>
                </span>
                <ChevronRight className="ap4-chev" size={16} aria-hidden="true" />
              </a>
              <button type="button" className="ap4-row cx4-row" onClick={onOpenAgents}>
                <span className="ap4-k">
                  <b>Claim agents</b>
                  <small>
                    Did your AI give you a claim link? Bring its agents into your account.
                  </small>
                </span>
                <ChevronRight className="ap4-chev" size={16} aria-hidden="true" />
              </button>
              <a className="ap4-row cx4-row" href="/docs/api">
                <span className="ap4-k">
                  <b>API and SDK docs</b>
                  <small>Connect your own agent or client.</small>
                </span>
                <ChevronRight className="ap4-chev" size={16} aria-hidden="true" />
              </a>
            </div>
            <p className="cx4-quiet">
              {ROOM_INVITE_CLIENTS} {CHATGPT_ADMIN_NOTE}
            </p>
          </section>
        </div>
      </div>
    </ConnectSurface.Provider>
  );
}
