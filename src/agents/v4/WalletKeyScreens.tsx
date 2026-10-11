import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { changePassword, MIN_PASSWORD_LENGTH, restoreFromBackup } from '../../base/vault';
import { IDLE_LOCK_MS } from '../../base/wallet/usePasswordLock';
import { SettingsFrame } from './settingsShared';
import { changeProblem, restoreProblem } from './walletKeyModel';

/*
 * The wallet key's two other forms, opened over the screen the owner was on: restore with the
 * backup key (a forgotten password), and change the password. Both go through src/base/vault only
 * (PUT /api/base/vault, purpose 'rewrap'), which holds the key here exactly as an unlock does
 * (keyPin.ts: only for the person signed in). Nothing typed is logged or shown back, and every field
 * is emptied after it worked, when the page is hidden or left, after IDLE_LOCK_MS without input,
 * and when the form closes.
 */

const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Try again.';

/** The quiet link under an unlock form. */
export function ForgotPasswordLink({
  onOpen,
  disabled,
}: {
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="v4s-quiet w4-forgot"
      data-k="forgot-password"
      disabled={disabled}
      onClick={onOpen}
    >
      Forgot your password? Restore with your backup key
    </button>
  );
}

/** Empties the form when the page is hidden or left, or after IDLE_LOCK_MS without input. */
function useClearWhenLeft(active: boolean, clear: () => void) {
  const latest = useRef(clear);
  latest.current = clear;
  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const left = () => latest.current();
    const hidden = () => {
      if (document.visibilityState === 'hidden') left();
    };
    const idle = window.setInterval(() => {
      if (Date.now() - last >= IDLE_LOCK_MS) left();
    }, 5_000);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', left);
    window.addEventListener('pointerdown', touch, true);
    window.addEventListener('keydown', touch, true);
    return () => {
      window.clearInterval(idle);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', left);
      window.removeEventListener('pointerdown', touch, true);
      window.removeEventListener('keydown', touch, true);
    };
  }, [active]);
}

/** Whether the form is still open: an answer that arrives after it closed is dropped. */
function useOpen() {
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return open;
}

/** Escape inside the form closes it (the pane would otherwise close the whole screen). */
const escapeTo = (onBack: () => void, busy: boolean) => (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || busy) return;
  event.preventDefault();
  onBack();
};

function NewPasswordFields({
  password,
  repeat,
  onPassword,
  onRepeat,
  label = 'New wallet password',
}: {
  password: string;
  repeat: string;
  onPassword: (value: string) => void;
  onRepeat: (value: string) => void;
  label?: string;
}) {
  return (
    <>
      <label className="w4-field">
        <span>{label}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
        />
        <small>At least {MIN_PASSWORD_LENGTH} characters. Central City never sees it.</small>
      </label>
      <label className="w4-field">
        <span>Repeat the new password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(event) => onRepeat(event.target.value)}
        />
      </label>
    </>
  );
}

/**
 * A forgotten password: the backup key shown once at setup, and a new password. The vault refuses
 * a key that doesn't open this account's own owner address before anything is written.
 */
export function RestoreKeyScreen({
  backLabel,
  onBack,
  onRestored,
}: {
  backLabel: string;
  onBack: () => void;
  onRestored: () => void;
}) {
  const [backup, setBackup] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = useOpen();
  const clear = () => {
    setBackup('');
    setPassword('');
    setRepeat('');
  };
  useClearWhenLeft(backup !== '' || password !== '' || repeat !== '', clear);

  async function restore(event: FormEvent) {
    event.preventDefault();
    setError('');
    // Checked here first: a refusal sends nothing.
    const problem = restoreProblem(backup, password, repeat);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await restoreFromBackup(backup, password);
      clear();
      if (open.current) onRestored();
    } catch (err) {
      if (open.current) setError(failure(err));
    } finally {
      if (open.current) setBusy(false);
    }
  }

  return (
    <SettingsFrame backLabel={backLabel} onBack={onBack} title="Restore with your backup key">
      <form
        className="w4-steps"
        data-k="restore-key"
        onSubmit={(event) => void restore(event)}
        onKeyDown={escapeTo(onBack, busy)}
      >
        <p className="w4-lead">
          Type the backup key you saved when you set up your wallet key. It was shown once, as 16
          groups of 4.
        </p>
        <p className="w4-hint">
          Restoring keeps the same wallet and the money in it, and sets a new password. The key
          never leaves this browser: it’s checked and locked again here.
        </p>
        <label className="w4-field">
          <span>Backup key</span>
          <textarea
            className="w4-mono"
            rows={3}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={backup}
            onChange={(event) => setBackup(event.target.value)}
          />
          <small>Spaces, dashes and a leading 0x are fine.</small>
        </label>
        <NewPasswordFields
          password={password}
          repeat={repeat}
          onPassword={setPassword}
          onRepeat={setRepeat}
        />
        {error ? (
          <p className="w4-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="ap4-btn w4-wide" disabled={busy} aria-busy={busy}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      </form>
    </SettingsFrame>
  );
}

/** A new password for the same key: the current one opens it, the new one locks it again. */
export function ChangePasswordScreen({
  backLabel,
  onBack,
  onChanged,
  onForgot,
}: {
  backLabel: string;
  onBack: () => void;
  onChanged: () => void;
  onForgot: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = useOpen();
  const clear = () => {
    setCurrent('');
    setPassword('');
    setRepeat('');
  };
  useClearWhenLeft(current !== '' || password !== '' || repeat !== '', clear);

  async function change(event: FormEvent) {
    event.preventDefault();
    setError('');
    const problem = changeProblem(current, password, repeat);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await changePassword(current, password);
      clear();
      if (open.current) onChanged();
    } catch (err) {
      if (!open.current) return;
      setCurrent('');
      setError(failure(err));
    } finally {
      if (open.current) setBusy(false);
    }
  }

  return (
    <SettingsFrame backLabel={backLabel} onBack={onBack} title="Change password">
      <form
        className="w4-steps"
        data-k="change-password"
        onSubmit={(event) => void change(event)}
        onKeyDown={escapeTo(onBack, busy)}
      >
        <p className="w4-lead">
          A new password for your wallet key. The key, its backup key and your wallets stay the
          same.
        </p>
        <label className="w4-field">
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <NewPasswordFields
          password={password}
          repeat={repeat}
          onPassword={setPassword}
          onRepeat={setRepeat}
          label="New password"
        />
        {error ? (
          <p className="w4-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="ap4-btn w4-wide" disabled={busy} aria-busy={busy}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
        <ForgotPasswordLink onOpen={onForgot} disabled={busy} />
      </form>
    </SettingsFrame>
  );
}
