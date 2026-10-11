import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AutoReplySheet, type SheetMode } from '../../responder';
import type { AgentScreenProps } from './messagesRoomsShared';
import {
  AUTO_REPLY_NOTE,
  autoReplyKeyAction,
  autoReplyLimitsLine,
  autoReplyPause,
  autoReplyState,
  removeKeyPrompt,
  type PauseFix,
} from './settingsActionsModel';
import {
  AUTO_REPLY_READS,
  autoReplySheetSend,
  removeAutoReplyKey,
  responderFailure,
  setAutoReply,
  type AutoReplyData,
} from './settingsRequests';
import {
  SettingsEmpty,
  SettingsError,
  SettingsFrame,
  SettingsLoading,
  Toggle,
  useSettingsLifecycle,
} from './settingsShared';

/** Where focus goes once the sheet or the remove confirmation has closed. */
type FocusTarget = 'switch' | 'setup' | 'settings' | 'change' | 'remove';

/**
 * Auto-reply: one switch (PUT /api/agents/:id/responder {enabled}). Owner decision G2: it answers
 * when mentioned in a room; direct-message replies come later, so the mockup's "Direct messages /
 * Everywhere" choice is not shown yet. Until a working key is saved the switch stays off and
 * disabled, and "Set up auto-reply" opens the agent settings' setup sheet (AutoReplySheet:
 * provider, model, key, limits, instructions and the consent) over the pane; with a key, Change
 * key opens its replace sheet and Remove key asks first. "Model and limits" opens its settings
 * sheet (model, instructions, both daily caps; no key). A pause says why, with its one fix. The
 * sheet's requests and the removal are
 * the screen's one action at a time, bound to its agent and workspace (settingsRequests.ts). The
 * sheet, with the key typed into it, and the confirmation belong to the generation they were
 * opened in: another agent or workspace, also coming back to this one, never shows them again,
 * and leaving the screen drops them.
 */
export function AutoReplyScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const { controller, view, load } = useSettingsLifecycle(
    agent.id,
    AUTO_REPLY_READS,
    responderFailure,
  );
  const read = load<AutoReplyData>('autoReply');
  const data = read.state === 'ready' ? read.data : null;
  const busy = Boolean(view.busy);
  const state = autoReplyState({
    loading: read.state === 'loading',
    failed: read.state === 'error',
    notFound: Boolean(data?.notFound),
    settings: data?.settings ?? null,
  });
  const keyAction = autoReplyKeyAction(state, data?.settings ?? null);

  const [sheet, setSheet] = useState<{ mode: SheetMode; generation: number } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const shownSheet = sheet && sheet.generation === view.generation ? sheet : null;
  const confirmOpen = confirming === view.generation && keyAction === 'manage';
  const promptId = useId();

  // Focus follows the sheet and the confirmation: back to what opened them, or to the switch once
  // set up. While an action is on its way the target may still be disabled; it takes focus once
  // usable, and the wish is dropped when nothing is on its way any more.
  const focusNext = useRef<FocusTarget | null>(null);
  const switchRow = useRef<HTMLDivElement>(null);
  const setupRow = useRef<HTMLButtonElement>(null);
  const settingsRow = useRef<HTMLButtonElement>(null);
  const changeRow = useRef<HTMLButtonElement>(null);
  const removeRow = useRef<HTMLButtonElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    const element =
      target === 'switch'
        ? switchRow.current?.querySelector<HTMLButtonElement>('[role="switch"]')
        : { setup: setupRow, settings: settingsRow, change: changeRow, remove: removeRow }[target]
            .current;
    if (element && !element.disabled) {
      focusNext.current = null;
      element.focus();
    } else if (!busy) focusNext.current = null;
  });
  useEffect(() => {
    if (confirmOpen) confirmBox.current?.focus();
  }, [confirmOpen]);

  const openSheet = (mode: SheetMode) => {
    if (busy) return;
    setConfirming(null);
    setSheet({ mode, generation: view.generation });
  };
  const closeSheet = (to: FocusTarget) => {
    focusNext.current = to;
    setSheet(null);
  };
  /** Where focus goes back to when a sheet of this mode closes without a save. */
  const opener = (mode: SheetMode): FocusTarget =>
    mode === 'setup' ? 'setup' : mode === 'settings' ? 'settings' : 'change';
  const fixPause = (fix: PauseFix) => {
    if (busy) return;
    if (fix.does !== 'resume') return openSheet(fix.does);
    // The fix goes once auto-reply runs again; focus waits on the switch.
    focusNext.current = 'switch';
    void setAutoReply(controller, true, view.generation);
  };
  const cancelRemove = () => {
    if (busy) return;
    focusNext.current = 'remove';
    setConfirming(null);
  };
  const remove = () => {
    if (busy) return;
    void removeAutoReplyKey(controller, view.generation, () => {
      focusNext.current = 'setup';
      setConfirming(null);
    });
  };
  function confirmKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    // Escape takes back the confirmation, not the screen.
    event.preventDefault();
    event.stopPropagation();
    cancelRemove();
  }

  const on = state === 'on' || state === 'paused';
  const pause = state === 'paused' && data?.settings ? autoReplyPause(data.settings) : null;
  const pauseFix = pause?.fix ?? null;
  const limits = data?.settings ? autoReplyLimitsLine(data.settings, data.models) : null;
  return (
    <SettingsFrame
      backLabel={backLabel ?? agent.name}
      onBack={onBack}
      title="Auto-reply"
      notice={view.notice}
    >
      {state === 'loading' ? (
        <SettingsLoading />
      ) : state === 'error' ? (
        <SettingsError
          message={read.state === 'error' ? read.message : 'Couldn’t load auto-reply.'}
          onRetry={() => void controller.reload('autoReply')}
        />
      ) : state === 'unavailable' ? (
        <SettingsEmpty title="Not available">Auto-reply isn’t offered here yet.</SettingsEmpty>
      ) : (
        <>
          <div className="ap4-group">
            <div ref={switchRow} className="ap4-row v4s-still">
              <span className="ap4-k">Reply automatically</span>
              {view.busy === 'save' ? <span className="v4s-spin" aria-hidden="true" /> : null}
              <Toggle
                checked={on}
                label="Reply automatically"
                disabled={busy || state === 'needs-key'}
                onChange={(next) => void setAutoReply(controller, next, view.generation)}
              />
            </div>
          </div>
          {on ? <p className="ap4-note">{AUTO_REPLY_NOTE}</p> : null}
          {pause ? (
            <div className="ap4-note v4s-pause" role="status">
              <span>{pause.text}</span>
              {pauseFix ? (
                <button
                  type="button"
                  className="v4s-quiet"
                  disabled={busy}
                  onClick={() => fixPause(pauseFix)}
                >
                  {pauseFix.label}
                </button>
              ) : null}
            </div>
          ) : null}
          {keyAction === 'setup' ? (
            <div className="ap4-group">
              <button
                ref={setupRow}
                type="button"
                className="ap4-row"
                disabled={busy}
                onClick={() => openSheet('setup')}
              >
                <span className="ap4-k">Set up auto-reply</span>
                <ChevronRight className="ap4-chev v4s-i v4s-i-sm" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {keyAction === 'manage' && !confirmOpen && data?.settings ? (
            <div className="ap4-group">
              <button
                ref={settingsRow}
                type="button"
                className="ap4-row v4s-tall"
                disabled={busy}
                onClick={() => openSheet('settings')}
              >
                {/* The whole line, wrapped: the daily caps matter as much as the model. */}
                <span className="ap4-two">
                  <b>Model and limits</b>
                  <span>{limits}</span>
                </span>
                <ChevronRight className="ap4-chev v4s-i v4s-i-sm" aria-hidden="true" />
              </button>
              <button
                ref={changeRow}
                type="button"
                className="ap4-row"
                disabled={busy}
                onClick={() => openSheet('key')}
              >
                <span className="ap4-k">Change key</span>
                <ChevronRight className="ap4-chev v4s-i v4s-i-sm" aria-hidden="true" />
              </button>
              <button
                ref={removeRow}
                type="button"
                className="ap4-row"
                disabled={busy}
                onClick={() => setConfirming(view.generation)}
              >
                <span className="ap4-k ap4-error">Remove key</span>
              </button>
            </div>
          ) : null}
          {confirmOpen && data?.settings ? (
            <>
              <p id={promptId} className="ap4-note">
                {removeKeyPrompt(data.settings)}
              </p>
              {/* The buttons stay focusable while the removal is on its way (aria-disabled), so
                  focus stays put, also when it fails and the confirmation stays. */}
              <div
                ref={confirmBox}
                className="ap4-form"
                role="group"
                aria-label="Remove the key?"
                aria-describedby={promptId}
                aria-busy={view.busy === 'remove' || undefined}
                tabIndex={-1}
                onKeyDown={confirmKeys}
              >
                <button
                  type="button"
                  className="ap4-btn ap4-danger-btn v4s-wide"
                  aria-disabled={busy || undefined}
                  onClick={remove}
                >
                  {view.busy === 'remove' ? (
                    <span className="v4s-spin v4s-spin-on" aria-hidden="true" />
                  ) : null}
                  Remove key
                </button>
                <button
                  type="button"
                  className="v4s-quiet"
                  aria-disabled={busy || undefined}
                  onClick={cancelRemove}
                >
                  Keep it
                </button>
              </div>
            </>
          ) : null}
          {view.error ? (
            <p className="ap4-note v4s-err" role="alert">
              {view.error}
            </p>
          ) : null}
          {shownSheet && data?.settings ? (
            <AutoReplySheet
              mode={shownSheet.mode}
              agent={agent}
              models={data.models}
              settings={data.settings}
              send={autoReplySheetSend(controller, shownSheet.generation)}
              onClose={() => closeSheet(opener(shownSheet.mode))}
              onSaved={() =>
                closeSheet(shownSheet.mode === 'setup' ? 'switch' : opener(shownSheet.mode))
              }
            />
          ) : null}
        </>
      )}
    </SettingsFrame>
  );
}
