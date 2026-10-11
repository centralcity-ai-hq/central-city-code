import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, Copy, FileSearch, ScanText, ShieldCheck, X } from 'lucide-react';
import type { Agent, Capability } from '../shared/types';
import { AgentSigil, type SigilAgent } from './circle';
import { CityMark } from './brand';

export { CityMark };

export const capabilityLabels: Record<Capability, string> = {
  research: 'Research',
  extract: 'Extraction',
  verify: 'Verification',
};
export const capabilityIcons = { research: FileSearch, extract: ScanText, verify: ShieldCheck };

export const statusLabels: Record<string, string> = {
  completed: 'Ready for review',
  queued: 'Waiting to start',
  running: 'In progress',
  failed: 'Failed',
  canceled: 'Canceled',
  accepted: 'Accepted',
  online: 'Online',
  working: 'Working',
  offline: 'Offline',
  revoked: 'Revoked',
  paused: 'Paused',
};

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <span className="status-dot" aria-hidden="true" />
      {statusLabels[value] ?? value.replaceAll('_', ' ')}
    </span>
  );
}

/** An agent's node glyph. Kept under its historical name; it now renders the circle sigil. */
export function AgentGlyph({
  agent,
  size = '',
  transmuting = false,
}: {
  agent: SigilAgent;
  size?: string;
  transmuting?: boolean;
}) {
  return (
    <AgentSigil
      agent={agent}
      size={size === 'large' ? 'large' : size === 'small' ? 'small' : 'medium'}
      transmuting={transmuting}
    />
  );
}

/** Plain-language provenance: who drew this agent into the city. */
export function creatorLabel(
  agent: Pick<Agent, 'createdBy' | 'parentAgentId' | 'claimedAt'>,
  nameOf: (id: string) => string | undefined,
) {
  const by = agent.createdBy;
  if (agent.parentAgentId) return `Created under ${nameOf(agent.parentAgentId) ?? 'another agent'}`;
  if (!by || by.kind === 'owner') return 'Created by you';
  if (by.kind === 'assistant') return 'Created by your AI';
  if (by.kind === 'oauth-client') return 'Created by a connected AI app';
  if (by.kind === 'workspace-key') return 'Created by an AI in this workspace';
  if (by.kind === 'anonymous-client')
    return agent.claimedAt ? 'Created by an AI app · claimed' : 'Created by an AI app';
  return 'Created by an agent';
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  live,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  /** Announces the empty state politely (role=status) where a page asks for it. */
  live?: boolean;
}) {
  return (
    <div className="empty-state" role={live ? 'status' : undefined}>
      <div className="empty-icon">
        {icon || (
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="21" />
            <circle cx="24" cy="24" r="9" />
          </svg>
        )}
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
  variant = 'default',
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** "confirm": a compact yes/no dialog with no kicker or close icon (see ConfirmDialog). */
  variant?: 'default' | 'confirm';
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
        ) || [],
      );
    (
      ref.current?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ||
      focusables().find((element) => element.tagName !== 'BUTTON') ||
      focusables()[0]
    )?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const elements = focusables();
        const first = elements[0],
          last = elements.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = originalOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={variant === 'confirm' ? 'modal modal-confirm' : `modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={variant === 'confirm' ? -1 : undefined}
      >
        {variant === 'confirm' ? (
          <h2 id={id} className="modal-confirm-title">
            {title}
          </h2>
        ) : (
          <div className="modal-heading">
            <div>
              <p className="eyebrow">Central City / Workspace</p>
              <h2 id={id}>{title}</h2>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
            <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * A compact confirm: a title, one short line, then Cancel and the action, right-aligned.
 * Esc and Cancel close it; focus starts on Cancel. While busy it can't be closed and focus rests
 * on the dialog itself, since both buttons are disabled.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  error,
  status,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  error?: string;
  status?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (busy) body.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
  }, [busy]);
  return (
    <Modal variant="confirm" title={title} onClose={() => (busy ? undefined : onClose())}>
      <div className="modal-confirm-body" ref={body}>
        {children}
        {error ? (
          <p className="modal-confirm-error" role="alert">
            {error}
          </p>
        ) : null}
        {status ? <p role="status">{status}</p> : null}
      </div>
      <div className="modal-confirm-actions">
        <button
          type="button"
          className="confirm-button ghost"
          data-autofocus
          disabled={busy}
          onClick={onClose}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`confirm-button ${tone}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} />
    </button>
  );
}

/**
 * Copies a value and announces the result politely. The visible label changes to "Copied" for a
 * few seconds; failures explain how to copy manually.
 */
export function CopyButton({
  value,
  label = 'Copy',
  describedAs,
  variant = 'secondary',
}: {
  value: string;
  label?: string;
  /** What is being copied, for the announcement ("Claude Code command"). */
  describedAs?: string;
  variant?: 'secondary' | 'primary' | 'quiet';
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span className="copy-control">
      <button
        type="button"
        className={`button ${variant} copy-button`}
        onClick={async () => {
          window.clearTimeout(timer.current);
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
          timer.current = window.setTimeout(() => setState('idle'), 3200);
        }}
      >
        {state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        {state === 'copied' ? 'Copied' : label}
      </button>
      <span className="copy-status" role="status">
        {state === 'copied'
          ? `${describedAs ?? 'Value'} copied to the clipboard.`
          : state === 'failed'
            ? 'Clipboard unavailable. Select and copy the text manually.'
            : ''}
      </span>
    </span>
  );
}

export function formatTime(value: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(value))
    : 'Never';
}
export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
