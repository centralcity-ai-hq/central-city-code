import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Agent } from '../../shared/types';
import { responderClient, ResponderError, type ResponderClient } from './api';
import {
  LIMITS,
  PROVIDERS,
  PROVIDER_NAMES,
  type ModelOption,
  type Provider,
  type ResponderSettingsView,
} from './contract';
import { consentNotice, costPerReply, parseUsd, setupErrorCopy } from './copy';

/*
 * Auto-reply's sheet for one agent (docs/RESPONDER.md), opened from My agents' Auto-reply screen.
 * The owner sets it up in one sheet: provider, model, a write-only API key, optional instructions
 * and daily limits, and a plain notice naming who receives room text. "Turn on" is the consent.
 * The key is sent once and never shown again.
 */

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

/** Without a `send`, the sheet sends its requests as they are. */
const sendDirect: SheetSend = (work) => work(responderClient);

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
