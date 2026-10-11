import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  LayoutGrid,
  Link2,
  Plug,
  Sparkles,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Agent, Capability } from '../../../shared/types';
import { api } from '../../api';
import { connectPanels, connectTarget, type AppId } from '../../Connect';
import { WorkspaceKeys } from '../../WorkspaceKeys';
import '../../connect.css';

/** The apps "Connect your AI" lists, in the mockup's order; Custom follows. */
const APPS: { id: AppId; name: string }[] = [
  { id: 'chatgpt', name: 'ChatGPT' },
  { id: 'claude', name: 'Claude' },
  { id: 'gemini-cli', name: 'Gemini' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'codex', name: 'Codex' },
];
const CAPABILITIES: { id: Capability; label: string }[] = [
  { id: 'research', label: 'Research' },
  { id: 'extract', label: 'Extract' },
  { id: 'verify', label: 'Verify' },
];

export interface AddPaneProps {
  busy: boolean;
  /** Today's claim form (the same component the console uses). */
  claimForm?: ReactNode;
  onTryExamples?: () => void;
  /** An agent the person runs themselves (gets a runtime token): today's Add an agent dialog. */
  onOwnAgent: () => void;
  /** A new agent was created; the list opens it. */
  onCreated: (agent: Agent) => Promise<void> | void;
}

/**
 * Add an agent, inside the detail pane (docs/design/my-agents-v4-mockup.html): Connect your AI
 * (each app's existing steps from Connect.tsx, plus Custom), Create a CC agent, Claim from a link,
 * Try example agents. Every screen has a back link; nothing here is new server behaviour.
 */
export function AddPane({ busy, claimForm, onTryExamples, onOwnAgent, onCreated }: AddPaneProps) {
  const [stack, setStack] = useState<string[]>(['add']);
  const top = stack[stack.length - 1]!;
  const go = (screen: string) => setStack((s) => [...s, screen]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const backTo = (() => {
    const previous = stack[stack.length - 2];
    return previous === 'connect' ? 'Connect your AI' : 'Add an agent';
  })();
  const header = (title: string, sub?: string) => (
    <>
      {stack.length > 1 ? (
        <button type="button" className="ap4-back" onClick={back}>
          <ChevronLeft size={16} aria-hidden="true" />
          {backTo}
        </button>
      ) : null}
      <h2 className="ap4-title" tabIndex={-1}>
        {title}
      </h2>
      {sub ? <p className="ap4-note">{sub}</p> : null}
    </>
  );

  let body: ReactNode;
  if (top === 'add') {
    body = (
      <>
        {header('Add an agent')}
        <div className="ap4-group">
          <Choice
            icon={<Plug size={16} />}
            title="Connect your AI"
            sub="ChatGPT, Claude, Gemini, Cursor, Codex or custom"
            onClick={() => go('connect')}
          />
          <Choice
            icon={<Sparkles size={16} />}
            title="Create a CC agent"
            sub="Scripted, no AI model"
            onClick={() => go('cc')}
          />
          {claimForm ? (
            <Choice
              icon={<Link2 size={16} />}
              title="Claim from a link"
              sub="Agents your AI created"
              onClick={() => go('claim')}
            />
          ) : null}
        </div>
        {onTryExamples ? (
          <div className="ap4-group">
            <Choice
              icon={<LayoutGrid size={16} />}
              title="Try example agents"
              sub="3 ready-made CC agents · remove anytime"
              disabled={busy}
              onClick={onTryExamples}
            />
          </div>
        ) : null}
      </>
    );
  } else if (top === 'connect') {
    body = (
      <>
        {header('Connect your AI')}
        <div className="ap4-group">
          {APPS.map((app) => (
            <Row key={app.id} label={app.name} onClick={() => go(`app:${app.id}`)} />
          ))}
        </div>
        <div className="ap4-group">
          <Row
            label="Custom"
            value="Any MCP client or your own agent"
            onClick={() => go('custom')}
          />
        </div>
        <p className="ap4-note">Connect once. Your AI joins as an agent you control.</p>
      </>
    );
  } else if (top.startsWith('app:')) {
    const id = top.slice(4) as AppId;
    const target = connectTarget(false);
    const panels = connectPanels({ open: false, ...target });
    body = (
      <>
        {header(APPS.find((app) => app.id === id)?.name ?? 'Connect')}
        <div className="ap4-connect">{panels[id]}</div>
      </>
    );
  } else if (top === 'custom') {
    const { endpoint } = connectTarget(false);
    body = (
      <>
        {header('Custom', 'Any MCP client or your own agent')}
        <div className="ap4-group">
          <div className="ap4-row ap4-static">
            <span className="ap4-k">Server</span>
            <span className="ap4-v ap4-mono">{endpoint.replace(/^https:\/\//, '')}</span>
            <CopyButton value={endpoint} label="Copy server address" />
          </div>
          <div className="ap4-row ap4-static">
            <span className="ap4-k">Sign-in</span>
            <span className="ap4-v">OAuth</span>
          </div>
        </div>
        <p className="ap4-note">Most clients sign in by themselves. No OAuth? Use a key.</p>
        <div className="ap4-group">
          <Row label="Workspace keys" onClick={() => go('keys')} />
          <Row label="An agent you run yourself" onClick={onOwnAgent} />
        </div>
      </>
    );
  } else if (top === 'keys') {
    body = <KeysScreen header={header('Workspace keys')} />;
  } else if (top === 'cc') {
    body = <CreateCc header={header('Create a CC agent')} onCreated={onCreated} />;
  } else {
    body = (
      <>
        {header(
          'Claim from a link',
          'Moves the agents and their history here. Each link works once.',
        )}
        <div className="ap4-claim">{claimForm}</div>
      </>
    );
  }
  return (
    <aside
      className="ap4"
      aria-label="Add an agent"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && stack.length > 1) {
          event.preventDefault();
          back();
        }
      }}
    >
      <div className="ap4-wrap">{body}</div>
    </aside>
  );
}

function Choice({
  icon,
  title,
  sub,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ap4-row ap4-choice" disabled={disabled} onClick={onClick}>
      <span className="ap4-mk" aria-hidden="true">
        {icon}
      </span>
      <span className="ap4-two">
        <b>{title}</b>
        <span>{sub}</span>
      </span>
      <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
    </button>
  );
}

function Row({ label, value, onClick }: { label: string; value?: string; onClick: () => void }) {
  return (
    <button type="button" className="ap4-row" onClick={onClick}>
      <span className="ap4-k">{label}</span>
      {value ? <span className="ap4-v">{value}</span> : null}
      <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
    </button>
  );
}

/** Copies a value; says "Copied" only after the clipboard accepted it. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ap4-cp"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

/** A scripted agent from a template (POST /api/agents, mode 'hosted', private card). */
function CreateCc({
  header,
  onCreated,
}: {
  header: ReactNode;
  onCreated: (agent: Agent) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [capability, setCapability] = useState<Capability>('research');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      {header}
      <form
        className="ap4-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || working) return;
          setWorking(true);
          setError('');
          try {
            const result = await api<{ agent: Agent }>('/api/agents', {
              name: name.trim(),
              description: '',
              capability,
              mode: 'hosted',
              visibility: 'private',
            });
            await onCreated(result.agent);
          } catch (err) {
            setError(err instanceof Error ? err.message : "The agent couldn't be created.");
          } finally {
            setWorking(false);
          }
        }}
      >
        <input
          className="ap4-field"
          aria-label="Name"
          placeholder="Name"
          autoFocus
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="ap4-seg" role="radiogroup" aria-label="What it does">
          {CAPABILITIES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={capability === item.id}
              data-on={capability === item.id ? 'true' : undefined}
              onClick={() => setCapability(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {error ? (
          <p className="ap4-note ap4-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="ap4-btn ap4-block" disabled={!name.trim() || working}>
          Create
        </button>
      </form>
    </>
  );
}

/** Workspace keys for clients without OAuth: the existing keys panel, unchanged. */
function KeysScreen({ header }: { header: ReactNode }) {
  return (
    <>
      {header}
      <p className="ap4-note">Use a key as Authorization: Bearer … in clients without OAuth.</p>
      <KeysPanel />
    </>
  );
}

function KeysPanel() {
  return (
    <div className="ap4-keys">
      <WorkspaceKeys workspaceName="this workspace" />
    </div>
  );
}
