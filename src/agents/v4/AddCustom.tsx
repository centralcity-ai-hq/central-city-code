import { Check, ChevronRight, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export function Row({
  label,
  value,
  onClick,
}: {
  label: string;
  value?: string;
  onClick: () => void;
}) {
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

/**
 * Custom: the server address and sign-in. Workspace keys show only in an AI-owned workspace (the
 * server answers 409 for any other); a person workspace uses "An agent you run yourself" instead.
 */
export function CustomScreen({
  header,
  endpoint,
  workspaceKeys,
  onKeys,
  onOwnAgent,
}: {
  header: ReactNode;
  endpoint: string;
  workspaceKeys: boolean;
  onKeys: () => void;
  onOwnAgent: () => void;
}) {
  return (
    <>
      {header}
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
      <p className="ap4-note">
        {workspaceKeys
          ? 'Most clients sign in by themselves. No OAuth? Use a key.'
          : 'Most clients sign in by themselves. No OAuth? Add an agent you run yourself.'}
      </p>
      <div className="ap4-group">
        {workspaceKeys ? <Row label="Workspace keys" onClick={onKeys} /> : null}
        <Row label="An agent you run yourself" onClick={onOwnAgent} />
      </div>
    </>
  );
}
