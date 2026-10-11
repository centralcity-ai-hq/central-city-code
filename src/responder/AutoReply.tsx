import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import type { Agent } from '../../shared/types';
import {
  getSettings,
  loadModels,
  removeKey,
  responderClient,
  ResponderError,
  updateSettings,
  type ResponderClient,
} from './api';
import {
  LIMITS,
  PROVIDERS,
  PROVIDER_NAMES,
  type ModelOption,
  type Provider,
  type ResponderSettingsView,
} from './contract';
import {
  consentNotice,
  costPerReply,
  parseUsd,
  pauseCopy,
  providerName,
  setupErrorCopy,
  shortDate,
} from './copy';

/*
 * Auto-reply for one agent (docs/RESPONDER.md). The owner sets it up in one sheet:
 * provider, model, a write-only API key, optional instructions and daily limits, and a plain notice
 * naming who receives room text. "Turn on" is the consent. The key is sent once and never shown
 * again: afterwards only "Key saved", its dates, Replace and Remove.
 *
 * Hidden entirely unless the server offers the feature (the model list loads).
 */

let modelsOnce: Promise<ModelOption[] | null> | null = null;
/** The model list, loaded once per page; null when this server has no auto-reply. */
function useModels(): ModelOption[] | null | undefined {
  const [models, setModels] = useState<ModelOption[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    modelsOnce ??= loadModels().then((result) => {
      if (!result) modelsOnce = null;
      return result;
    });
    void modelsOnce.then((result) => {
      if (live) setModels(result);
    });
    return () => {
      live = false;
    };
  }, []);
  return models;
}

export type SheetMode = 'setup' | 'key' | 'settings';

/**
 * How the sheet's requests go out. `work` sends them with the client it is given and returns what
 * was saved; `done` is the line that says so. `send` resolves to what was saved, or to null when
 * the requests did not finish here (the screen that opened the sheet moved on to another agent or
 * workspace, or another action was on its way): then the sheet shows nothing more. A failure
 * rejects with a ResponderError.
 */
export type SheetSend = (
  work: (client: ResponderClient) => Promise<ResponderSettingsView>,
  done: string,
) => Promise<ResponderSettingsView | null>;

/** The agent's settings dialog sends the sheet's requests as they are. */
const sendDirect: SheetSend = (work) => work(responderClient);

export function AutoReplySection({ agent }: { agent: Agent }) {
  const models = useModels();
  const [settings, setSettings] = useState<ResponderSettingsView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!models) return;
    const version = ++requestVersion.current;
    setSettings(null);
    setLoadError(false);
    setBusy(false);
    setRefreshing(false);
    setConfirmRemove(false);
    setError('');
    setNotice('');
    getSettings(agent.id)
      .then((value) => version === requestVersion.current && setSettings(value))
      .catch(() => version === requestVersion.current && setLoadError(true));
    return () => {
      requestVersion.current++;
      inFlight.current = false;
    };
  }, [models, agent.id]);

  if (!models || agent.revokedAt) return null;

  function beginRequest() {
    if (inFlight.current) return null;
    inFlight.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    return () => version === requestVersion.current;
  }

  function finishRequest(isCurrent: () => boolean) {
    if (!isCurrent()) return;
    inFlight.current = false;
    setBusy(false);
    setRefreshing(false);
  }

  function showActionError(err: unknown) {
    setError(
      setupErrorCopy(err instanceof ResponderError ? err.code : '', {
        provider: settings?.provider ?? 'openai',
        status: err instanceof ResponderError ? err.status : 0,
      }).message,
    );
  }

  async function refreshSettings() {
    const isCurrent = beginRequest();
    if (!isCurrent) return;
    setRefreshing(true);
    try {
      const value = await getSettings(agent.id);
      if (!isCurrent()) return;
      if (document.activeElement === retryRef.current) headingRef.current?.focus();
      setSettings(value);
      setLoadError(false);
    } catch {
      if (isCurrent()) setLoadError(true);
    } finally {
      finishRequest(isCurrent);
    }
  }

  async function run(action: () => Promise<ResponderSettingsView>, done: string) {
    const isCurrent = beginRequest();
    if (!isCurrent) return;
    setError('');
    setNotice('');
    try {
      const value = await action();
      if (!isCurrent()) return;
      setSettings(value);
      setLoadError(false);
      setNotice(done);
    } catch (err) {
      if (isCurrent()) showActionError(err);
    } finally {
      finishRequest(isCurrent);
    }
  }
  const setEnabled = (enabled: boolean) =>
    run(
      () => updateSettings(agent.id, { enabled }),
      enabled ? 'Auto-reply is on.' : 'Auto-reply is off.',
    );
  async function remove() {
    const isCurrent = beginRequest();
    if (!isCurrent) return;
    setError('');
    setNotice('');
    try {
      await removeKey(agent.id);
      if (!isCurrent()) return;
      if (confirmationRef.current?.contains(document.activeElement)) headingRef.current?.focus();
      // DELETE confirms these fields even when the subsequent read is unavailable.
      setSettings((current) =>
        current
          ? { ...current, enabled: false, status: 'off', pause_reason: 'key_removed', key: null }
          : current,
      );
      setConfirmRemove(false);
      setNotice('Key removed. Auto-reply is off.');
      setLoadError(false);
      setRefreshing(true);
      try {
        const value = await getSettings(agent.id);
        if (isCurrent()) setSettings(value);
      } catch {
        if (isCurrent()) setLoadError(true);
      }
    } catch (err) {
      if (isCurrent()) showActionError(err);
    } finally {
      finishRequest(isCurrent);
    }
  }

  const hasKey = settings?.key?.status === 'active';
  const state: 'loading' | 'error' | 'unset' | 'on' | 'paused' | 'off' =
    loadError && !settings
      ? 'error'
      : !settings
        ? 'loading'
        : settings.status === 'paused' ||
            (!settings.enabled && !settings.key && settings.pause_reason === 'key_removed')
          ? 'paused'
          : settings.enabled
            ? 'on'
            : hasKey
              ? 'off'
              : 'unset';
  const model = models.find(
    (item) => item.provider === settings?.provider && item.id === settings?.model,
  );
  const pause = settings
    ? pauseCopy(settings.pause_reason, settings.provider, settings.paused_until)
    : null;

  return (
    <section className="ar-section" aria-labelledby={titleId} data-state={state}>
      <div className="ar-head">
        <div>
          <h3 id={titleId} ref={headingRef} tabIndex={-1}>
            Auto-reply
          </h3>
          <p className="ar-muted">
            Reply automatically when @mentioned in a room. Uses your own OpenAI or Anthropic API
            key.
          </p>
        </div>
        {state === 'on' || state === 'off' ? (
          <button
            type="button"
            role="switch"
            className="ar-switch"
            aria-checked={state === 'on'}
            aria-label="Auto-reply"
            disabled={busy}
            onClick={() => void setEnabled(state !== 'on')}
          >
            <span className="ar-switch-track" aria-hidden="true">
              <span className="ar-switch-thumb" />
            </span>
            <span>{state === 'on' ? 'On' : 'Off'}</span>
          </button>
        ) : null}
      </div>

      {state === 'loading' || (refreshing && !settings) ? (
        <p className="ar-muted" role="status">
          Loading…
        </p>
      ) : null}
      {refreshing && settings ? (
        <p className="ar-muted" role="status">
          Refreshing auto-reply settings…
        </p>
      ) : null}
      {loadError ? (
        <p className="ar-error" role="alert">
          {settings
            ? 'The key was removed, but auto-reply settings could not be refreshed.'
            : "Couldn't load auto-reply."}{' '}
          <button
            ref={retryRef}
            type="button"
            className="ar-link"
            aria-disabled={busy}
            onClick={() => void refreshSettings()}
          >
            Retry
          </button>
        </p>
      ) : null}
      {state === 'unset' ? (
        <div className="ar-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setSheet('setup')}
          >
            Set up
          </button>
        </div>
      ) : null}

      {state === 'paused' && pause ? (
        <div className="ar-paused" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{pause.text}</span>
          {pause.action === 'change_key' ? (
            <button
              type="button"
              className="ar-link"
              disabled={busy}
              onClick={() => setSheet(hasKey ? 'key' : 'setup')}
            >
              {hasKey ? 'Change key' : 'Add a key'}
            </button>
          ) : pause.action === 'resume' ? (
            <button
              type="button"
              className="ar-link"
              disabled={busy}
              onClick={() => void setEnabled(true)}
            >
              Resume
            </button>
          ) : pause.action === 'pick_model' ? (
            <button
              type="button"
              className="ar-link"
              disabled={busy}
              onClick={() => setSheet('settings')}
            >
              Pick a model
            </button>
          ) : null}
        </div>
      ) : null}

      {settings && (state === 'on' || state === 'off' || (state === 'paused' && hasKey)) ? (
        <>
          <p className="ar-meta">
            {providerName(settings.provider)} · {model?.name ?? settings.model} · up to{' '}
            {settings.daily_reply_cap.toLocaleString('en-US')} replies a day · stops after about $
            {settings.daily_spend_cap_usd.toFixed(2)} a day
          </p>
          {settings.key ? (
            <p className="ar-meta">
              <span>
                Key saved · added {shortDate(settings.key.added_at)}
                {settings.key.validated_at
                  ? ` · checked ${shortDate(settings.key.validated_at)}`
                  : ''}
              </span>
              <button
                type="button"
                className="ar-link"
                disabled={busy}
                onClick={() => setSheet('key')}
              >
                Replace
              </button>
              <button
                type="button"
                className="ar-link danger"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </button>
            </p>
          ) : null}
          {confirmRemove ? (
            <div
              ref={confirmationRef}
              className="ar-confirm"
              role="group"
              aria-label="Remove the key?"
              aria-busy={busy}
            >
              <p>
                Remove the key? Auto-reply turns off. To be certain the key can't be used anywhere,
                also delete it at {providerName(settings.key?.provider ?? settings.provider)}.
              </p>
              <button
                type="button"
                className="button danger"
                aria-disabled={busy}
                onClick={() => void remove()}
              >
                Remove key
              </button>
              <button
                type="button"
                className="button ghost"
                aria-disabled={busy}
                onClick={() => !inFlight.current && setConfirmRemove(false)}
              >
                Keep it
              </button>
            </div>
          ) : null}
          <div className="ar-actions">
            <button
              type="button"
              className="ar-link"
              disabled={busy}
              onClick={() => setSheet('settings')}
            >
              Settings
            </button>
          </div>
          {!settings.replies_available && state === 'on' ? (
            <p className="ar-muted">
              Saved. Replies start once auto-reply finishes rolling out on this server.
            </p>
          ) : null}
        </>
      ) : null}

      {error ? (
        <p className="ar-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="visually-hidden" aria-live="polite">
        {notice}
      </p>

      {sheet ? (
        <AutoReplySheet
          mode={sheet}
          agent={agent}
          models={models}
          settings={settings}
          onClose={() => setSheet(null)}
          onSaved={(value, message) => {
            requestVersion.current++;
            setSettings(value);
            setLoadError(false);
            setNotice(message);
            setError('');
            setSheet(null);
          }}
        />
      ) : null}
    </section>
  );
}

/** Native modal dialog: top layer above the agent sheet, focus kept inside, Esc cancels. */
function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal?.();
    return () => dialog.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className="ar-sheet"
      aria-labelledby={titleId}
      // The agent sheet underneath listens for Esc and Tab on the document; keep ours to ourselves.
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="ar-sheet-head">
        <h2 id={titleId}>{title}</h2>
      </div>
      {children}
    </dialog>
  );
}

export function AutoReplySheet({
  mode,
  agent,
  models,
  settings,
  send = sendDirect,
  onClose,
  onSaved,
}: {
  mode: SheetMode;
  agent: Pick<Agent, 'id' | 'name'>;
  models: ModelOption[];
  settings: ResponderSettingsView | null;
  /** Where the requests go (SheetSend); straight out by default. */
  send?: SheetSend;
  onClose: () => void;
  onSaved: (settings: ResponderSettingsView, message: string) => void;
}) {
  const initialProvider: Provider = settings?.provider ?? 'anthropic';
  const defaultModel = (provider: Provider) =>
    models.find((item) => item.provider === provider && item.default)?.id ??
    models.find((item) => item.provider === provider)?.id ??
    '';
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [model, setModel] = useState(
    settings?.provider === initialProvider && settings.model
      ? settings.model
      : defaultModel(initialProvider),
  );
  const [key, setKey] = useState('');
  const [instructions, setInstructions] = useState(settings?.instructions ?? '');
  const [replyCap, setReplyCap] = useState(
    String(settings?.daily_reply_cap ?? LIMITS.replyCap.default),
  );
  const [spendCap, setSpendCap] = useState(
    (settings?.daily_spend_cap_usd ?? LIMITS.spendCapUsd.default).toFixed(2),
  );
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{
    key?: string;
    model?: string;
    replyCap?: string;
    spendCap?: string;
    form?: string;
  }>({});
  const [retry, setRetry] = useState(false);
  // Once the server has the key, a retry of the settings step never sends it again.
  const [keySaved, setKeySaved] = useState(false);
  // One submit at a time, also for a second Enter before the busy button has rendered.
  const sending = useRef(false);
  const ids = { key: useId(), model: useId(), reply: useId(), spend: useId(), instr: useId() };

  const needsKey = mode !== 'settings';
  const editsSettings = mode !== 'key';
  const options = models.filter((item) => item.provider === provider);
  const chosen = options.find((item) => item.id === model);

  function pickProvider(next: Provider) {
    setProvider(next);
    setModel(settings?.provider === next && settings.model ? settings.model : defaultModel(next));
    setErrors({});
  }

  function validate() {
    const found: typeof errors = {};
    if (needsKey && !keySaved) {
      const trimmed = key.trim();
      if (!trimmed) found.key = `Paste your ${PROVIDER_NAMES[provider]} API key.`;
      else if (trimmed.length < LIMITS.keyLength.min || trimmed.length > LIMITS.keyLength.max)
        found.key = setupErrorCopy('invalid_key_format', { provider }).message;
    }
    if (!chosen) found.model = 'Choose a model.';
    if (editsSettings) {
      const replies = Number(replyCap);
      if (
        !Number.isInteger(replies) ||
        replies < LIMITS.replyCap.min ||
        replies > LIMITS.replyCap.max
      )
        found.replyCap = `Enter a whole number from ${LIMITS.replyCap.min} to ${LIMITS.replyCap.max.toLocaleString('en-US')}.`;
      const spend = parseUsd(spendCap);
      if (spend === null || spend < LIMITS.spendCapUsd.min || spend > LIMITS.spendCapUsd.max)
        found.spendCap = 'Enter an amount from $0.01 to $50.';
    }
    return found;
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (sending.current) return;
    const found = validate();
    setErrors(found);
    setRetry(false);
    if (Object.keys(found).length) return;
    sending.current = true;
    setBusy(true);
    const done =
      mode === 'setup' ? 'Auto-reply is on.' : mode === 'key' ? 'Key saved.' : 'Settings saved.';
    // The server clears a pause only on enabled:true, so "Pick a model" would otherwise save the new
    // model and leave auto-reply paused for good.
    const resume =
      mode === 'settings' &&
      settings?.status === 'paused' &&
      settings.pause_reason === 'model_unavailable';
    try {
      const saved = await send(async (client) => {
        if (needsKey && !keySaved) {
          await client.saveKey(agent.id, { provider, model, key: key.trim() });
          // The key leaves the page's state as soon as the server has accepted it.
          setKey('');
          setKeySaved(true);
        }
        const body = editsSettings
          ? {
              model,
              instructions,
              daily_reply_cap: Number(replyCap),
              daily_spend_cap_usd: parseUsd(spendCap)!,
              ...(mode === 'setup' || resume ? { enabled: true } : {}),
            }
          : settings?.model !== model
            ? { model }
            : {};
        return client.updateSettings(agent.id, body);
      }, done);
      if (saved) onSaved(saved, done);
    } catch (err) {
      const copy = setupErrorCopy(err instanceof ResponderError ? err.code : '', {
        provider,
        model: chosen?.name,
        status: err instanceof ResponderError ? err.status : 0,
      });
      setErrors(copy.field ? { [copy.field]: copy.message } : { form: copy.message });
      // A key the provider or the server rejected has no reason to stay in the page.
      if (
        err instanceof ResponderError &&
        ['invalid_key', 'forbidden_key', 'unsupported_key', 'invalid_key_format'].includes(err.code)
      )
        setKey('');
      setRetry(Boolean(copy.retry));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const title =
    mode === 'setup'
      ? `Set up auto-reply for ${agent.name}`
      : mode === 'key'
        ? 'Replace the key'
        : 'Auto-reply settings';
  const primary = mode === 'setup' ? 'Turn on' : mode === 'key' ? 'Save key' : 'Save';

  return (
    <Sheet title={title} onClose={() => !busy && onClose()}>
      <form className="ar-form" noValidate onSubmit={(event) => void submit(event)}>
        {mode !== 'settings' ? (
          <fieldset className="ar-segmented">
            <legend>Provider</legend>
            <div>
              {PROVIDERS.map((item) => (
                <label key={item}>
                  <input
                    type="radio"
                    name="ar-provider"
                    value={item}
                    checked={provider === item}
                    onChange={() => pickProvider(item)}
                  />
                  <span>{PROVIDER_NAMES[item]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="ar-field">
          <label htmlFor={ids.model}>Model</label>
          <select
            id={ids.model}
            value={model}
            aria-invalid={Boolean(errors.model)}
            aria-describedby={errors.model ? `${ids.model}-e` : undefined}
            onChange={(event) => setModel(event.target.value)}
          >
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {costPerReply(item.est_cost_per_reply_usd)}
              </option>
            ))}
          </select>
          {errors.model ? (
            <p id={`${ids.model}-e`} className="ar-error">
              {errors.model}
            </p>
          ) : null}
        </div>

        {needsKey && keySaved ? (
          <p className="ar-muted" role="status">
            Key saved.
          </p>
        ) : null}
        {needsKey && !keySaved ? (
          <div className="ar-field">
            <label htmlFor={ids.key}>{PROVIDER_NAMES[provider]} API key</label>
            <input
              id={ids.key}
              className="ar-key"
              type="password"
              // An API key is not this site's password: keep password managers from saving or
              // filling it. new-password stops most browsers from saving it
              // as the centralcity.ai login; the data-* attributes cover 1Password, LastPass and
              // Bitwarden.
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              spellCheck={false}
              autoCapitalize="off"
              value={key}
              aria-invalid={Boolean(errors.key)}
              aria-describedby={`${ids.key}-h${errors.key ? ` ${ids.key}-e` : ''}`}
              onChange={(event) => setKey(event.target.value)}
            />
            {errors.key ? (
              <p id={`${ids.key}-e`} className="ar-error">
                {errors.key}
              </p>
            ) : null}
            <p id={`${ids.key}-h`} className="ar-muted">
              Create a key at{' '}
              {provider === 'openai' ? 'platform.openai.com' : 'console.anthropic.com'}. A ChatGPT
              Plus or Claude Pro subscription is not an API key. Use a separate key with its own
              spending limit. The key is never shown again.
            </p>
          </div>
        ) : null}

        {editsSettings ? (
          <>
            <details className="ar-details" open={mode === 'settings' || Boolean(instructions)}>
              <summary>Instructions</summary>
              <div className="ar-field">
                <label htmlFor={ids.instr} className="visually-hidden">
                  Instructions
                </label>
                <textarea
                  id={ids.instr}
                  rows={4}
                  maxLength={LIMITS.instructionsMax}
                  value={instructions}
                  placeholder={`How should ${agent.name} answer? For example: Answer briefly.`}
                  onChange={(event) => setInstructions(event.target.value)}
                />
                <p className="ar-muted">
                  {instructions.length.toLocaleString('en-US')} /{' '}
                  {LIMITS.instructionsMax.toLocaleString('en-US')}
                </p>
              </div>
            </details>
            <details
              className="ar-details"
              open={mode === 'settings' || Boolean(errors.replyCap || errors.spendCap)}
            >
              <summary>Limits</summary>
              <div className="ar-limits">
                <div className="ar-field">
                  <label htmlFor={ids.reply}>Replies a day, at most</label>
                  <input
                    id={ids.reply}
                    type="number"
                    inputMode="numeric"
                    min={LIMITS.replyCap.min}
                    max={LIMITS.replyCap.max}
                    step={1}
                    value={replyCap}
                    aria-invalid={Boolean(errors.replyCap)}
                    aria-describedby={errors.replyCap ? `${ids.reply}-e` : undefined}
                    onChange={(event) => setReplyCap(event.target.value)}
                  />
                  {errors.replyCap ? (
                    <p id={`${ids.reply}-e`} className="ar-error">
                      {errors.replyCap}
                    </p>
                  ) : null}
                </div>
                <div className="ar-field">
                  <label htmlFor={ids.spend}>
                    Stop after about this much a day (US$, estimated)
                  </label>
                  <input
                    id={ids.spend}
                    inputMode="decimal"
                    value={spendCap}
                    aria-invalid={Boolean(errors.spendCap)}
                    aria-describedby={errors.spendCap ? `${ids.spend}-e` : undefined}
                    onChange={(event) => setSpendCap(event.target.value)}
                  />
                  {errors.spendCap ? (
                    <p id={`${ids.spend}-e`} className="ar-error">
                      {errors.spendCap}
                    </p>
                  ) : null}
                </div>
              </div>
            </details>
          </>
        ) : null}

        {mode === 'setup' ? (
          <p className="ar-notice">{consentNotice(agent.name, provider)}</p>
        ) : null}

        {errors.form ? (
          <p className="ar-error" role="alert">
            {errors.form}
          </p>
        ) : null}

        <div className="ar-sheet-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
            {busy
              ? needsKey && !keySaved
                ? 'Checking your key…'
                : 'Saving…'
              : retry
                ? 'Try again'
                : primary}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
