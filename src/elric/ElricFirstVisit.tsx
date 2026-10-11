import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api, ApiError } from '../api';
import { ELRIC_NAME } from '../../shared/elric-copy';
import { ElricMark } from './ElricMark';
import { ElricSheet } from './ElricSheet';
import { gateSteps } from './elricV3';
import { readPendingDraft } from './pendingDraft';

/**
 * Signed in, no Elric yet: the first-visit card (WORKSPACE_V3_ELRIC_AGENTS.md §1 "First visit").
 * Elric's avatar, "Meet Elric", one sentence and two steps: Link Google (the account page), then
 * Confirm age (a date of birth sheet, POST /api/elric/age; the server alone decides 18+). Done
 * steps show a green check. With both done, Start chatting creates Elric (POST /api/elric) and the
 * chat opens. While a step is missing, fixed examples of what Elric does sit under the card.
 */
export function ElricFirstVisit({ onReady }: { onReady: () => void }) {
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [dob, setDob] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // GET /api/elric could not be read: no step is claimed as done and the age step stays closed.
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    let live = true;
    void api<{ eligible?: boolean; eligibility_reason?: string | null }>(
      '/api/elric',
      undefined,
      'GET',
    )
      .then((value) => {
        if (!live) return;
        setReason(value.eligibility_reason ?? null);
        setEligible(value.eligible === true);
      })
      .catch(() => {
        if (!live) return;
        setUnread(true);
        setEligible(false);
      });
    return () => {
      live = false;
    };
  }, []);

  async function start(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!eligible) await api('/api/elric/age', { date_of_birth: dob });
      await api('/api/elric', { name: ELRIC_NAME });
      setAsking(false);
      onReady();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'elric_age_under_18') {
        setAsking(false);
        setReason('age_under_18');
      } else if (code === 'google_link_required') {
        setAsking(false);
        setReason('unverified');
      } else if (code === 'invalid_date_of_birth') setError('Enter a valid date.');
      else setError(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (eligible === null) return null;
  const steps = gateSteps(eligible, reason);
  if (steps.adultsOnly)
    return (
      <div className="elx-empty elx3-gate" role="status">
        <ElricMark size="orb" />
        <h2>Elric is for adults</h2>
        <p>Elric is available from age 18.</p>
      </div>
    );
  // A message typed before signing in waits for the chat (pendingDraft.ts).
  const kept = readPendingDraft() ? (
    <p className="elx-meta elx-gate-kept">Your message will be in the chat after this step.</p>
  ) : null;
  return (
    <section className="elx-empty elx-setup elx3-gate" aria-labelledby="elx3-gate-title">
      <ElricMark size="orb" />
      <h1 id="elx3-gate-title">Meet Elric</h1>
      <p className="elx3-gate-lead">
        Central City’s built-in AI. It answers in your private chats and in the rooms you add it to,
        and asks you before it creates anything.
      </p>
      <ol className="elx3-steps" aria-label="Before you start">
        <li className="elx3-step" data-done={steps.google ? 'true' : undefined}>
          <span className="elx3-step-n" aria-hidden="true">
            {steps.google ? <Check size={15} strokeWidth={2.6} /> : '1'}
          </span>
          <span className="elx3-step-text">
            <b>Link your Google account</b>
            <small>Elric needs a verified Google account.</small>
          </span>
          {steps.google ? (
            <span className="elx3-status is-ok">
              <i aria-hidden="true" />
              Linked
            </span>
          ) : (
            <a className="elx-primary elx3-btn is-primary is-sm" href="/settings/account">
              Link Google
            </a>
          )}
        </li>
        <li className="elx3-step" data-done={steps.age ? 'true' : undefined}>
          <span className="elx3-step-n" aria-hidden="true">
            {steps.age ? <Check size={15} strokeWidth={2.6} /> : '2'}
          </span>
          <span className="elx3-step-text">
            <b>Confirm you’re 18 or older</b>
            <small>Elric is for adults. Asked once.</small>
          </span>
          {steps.age ? (
            <span className="elx3-status is-ok">
              <i aria-hidden="true" />
              Confirmed
            </span>
          ) : (
            <button
              type="button"
              className={`elx3-btn is-sm ${steps.google ? 'is-primary' : 'is-ghost'}`}
              aria-haspopup="dialog"
              disabled={!steps.ageOpen}
              onClick={() => setAsking(true)}
            >
              Confirm age
            </button>
          )}
        </li>
      </ol>
      {unread ? (
        <p className="elx-auth-error" role="alert">
          Your account couldn’t be checked. Reload the page to try again.
        </p>
      ) : null}
      {eligible ? (
        <button
          type="button"
          className="elx-primary elx3-btn is-primary"
          disabled={busy}
          onClick={() => void start()}
        >
          Start chatting
        </button>
      ) : null}
      {error && !asking ? (
        <p className="elx-auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {kept}
      {asking ? (
        <ElricSheet title="Confirm your age" onClose={() => setAsking(false)}>
          <form className="elx3-dob" onSubmit={(event) => void start(event)}>
            <input
              type="date"
              required
              autoFocus
              value={dob}
              aria-label="Date of birth"
              aria-describedby={error ? 'elx-gate-error' : 'elx3-dob-note'}
              onChange={(event) => setDob(event.target.value)}
            />
            <p id="elx3-dob-note" className="elx3-sheet-text">
              Your date of birth, once. It only confirms you’re 18 or older.
            </p>
            {error ? (
              <p id="elx-gate-error" className="elx3-sheet-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="elx3-sheet-foot">
              <button type="button" className="elx3-btn is-ghost" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button type="submit" className="elx3-btn is-primary" disabled={busy || !dob}>
                Confirm your age
              </button>
            </div>
          </form>
        </ElricSheet>
      ) : null}
    </section>
  );
}
