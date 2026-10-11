import { Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Agent, Snapshot } from '../../../shared/types';
import type { AgentScreenProps } from './messagesRoomsShared';
import { canRotate, keyHint, maskKey } from './settingsActionsModel';
import { SNAPSHOT_READS, rotateKey } from './settingsRequests';
import {
  ConfirmBox,
  SettingsEmpty,
  SettingsError,
  SettingsFrame,
  SettingsLoading,
  useSettingsLifecycle,
} from './settingsShared';

/**
 * Rotate key (owner decision G3: only agents that have a key). Confirm with the agent's name, then
 * POST /api/agents/:id/rotate-credential. The new key is shown once, masked, with Copy. It lives
 * only in the screen's lifecycle: dropped on Done, when the screen closes, and with every other
 * agent or workspace; an answer that arrives after such a change is never shown.
 */
export function RotateKeyScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const { controller, view, load } = useSettingsLifecycle(agent.id, SNAPSHOT_READS);
  const snapshot = load<Snapshot>('snapshot');
  const current: Agent | undefined =
    snapshot.state === 'ready'
      ? snapshot.data.agents.find((item) => item.id === agent.id)
      : undefined;
  const back = backLabel ?? 'Developer details';

  if (view.secret)
    return (
      <NewKey
        token={view.secret}
        name={agent.name}
        backLabel={back}
        onDone={() => {
          controller.clearSecret();
          onBack();
        }}
      />
    );

  const hint = keyHint(current);
  return (
    <SettingsFrame backLabel={back} onBack={onBack} title="Rotate key">
      {snapshot.state === 'loading' ? (
        <SettingsLoading />
      ) : snapshot.state === 'error' ? (
        <SettingsError
          message={snapshot.message}
          onRetry={() => void controller.reload('snapshot')}
        />
      ) : !canRotate(current) ? (
        <SettingsEmpty title="No key to rotate">{agent.name} doesn’t use a key.</SettingsEmpty>
      ) : (
        <>
          {hint ? (
            <div className="ap4-group">
              <div className="ap4-row v4s-still">
                <span className="ap4-k">Key</span>
                <span className="ap4-v v4s-mono">{hint}</span>
              </div>
            </div>
          ) : null}
          {/* The server stops every active job of the agent on rotate, so this is said first. */}
          <p className="ap4-note ap4-wraps">
            Stop the agent first. The old key stops working at once and unfinished work for{' '}
            {agent.name} is canceled; its connections and history stay.
          </p>
          <ConfirmBox
            name={agent.name}
            typed={view.confirm}
            onTyped={controller.setConfirm}
            label="Rotate key"
            busy={view.busy === 'rotate'}
            error={view.error}
            onConfirm={() => void rotateKey(controller, view.generation)}
            onCancel={onBack}
          />
        </>
      )}
    </SettingsFrame>
  );
}

/** "New key": shown once, Copy key, Done. Nothing of it is kept after this screen. */
function NewKey({
  token,
  name,
  backLabel,
  onDone,
}: {
  token: string;
  name: string;
  backLabel: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const copyButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    copyButton.current?.focus();
    return () => window.clearTimeout(timer.current);
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied('yes');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied('no'), 1700);
    } catch {
      // Without a clipboard the key is shown in full below, so it is never lost.
      setCopied('failed');
    }
  }
  return (
    <SettingsFrame backLabel={backLabel} onBack={onDone} title="New key">
      <div className="v4s-keybox" aria-label="New key">
        {copied === 'failed' ? token : maskKey(token)}
      </div>
      <p className="ap4-note">Shown once. Copy it now; the old key stopped working.</p>
      <p className="ap4-note ap4-wraps">
        Put it in {name}’s setup and restart it. Anyone with this key can act as {name}; never paste
        it into a chat.
      </p>
      {copied === 'failed' ? (
        <p className="ap4-note v4s-err" role="alert">
          Couldn’t copy. Select the key above and copy it.
        </p>
      ) : null}
      <button
        ref={copyButton}
        type="button"
        className="ap4-btn v4s-wide"
        onClick={() => void copy()}
      >
        <Copy className="v4s-i" aria-hidden="true" />
        {copied === 'yes' ? 'Copied' : 'Copy key'}
      </button>
      <span className="visually-hidden" role="status">
        {copied === 'yes' ? 'Copied' : ''}
      </span>
      <button type="button" className="v4s-quiet" onClick={onDone}>
        Done
      </button>
    </SettingsFrame>
  );
}
