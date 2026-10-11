import { useCallback, useEffect, useState } from 'react';
import { Mail, SUPPORT_EMAIL } from './common';

/*
 * /status: live health, checked from the visitor's browser. There is no dedicated health
 * endpoint; the checks use the public endpoints that monitoring already relies on:
 * GET /api/session (the API answers; Playwright and the canary wait on it) and
 * GET /api/public/stats (the public agent count, read from the database).
 */
type State = 'checking' | 'up' | 'slow' | 'down';
type Check = { id: string; label: string; url: string; state: State; ms: number | null };

const CHECKS: Omit<Check, 'state' | 'ms'>[] = [
  { id: 'api', label: 'Website and API', url: '/api/session' },
  { id: 'data', label: 'Public data (agent count)', url: '/api/public/stats' },
];
const TIMEOUT_MS = 10_000;
const SLOW_MS = 3_000;

const WORDS: Record<State, string> = {
  checking: 'Checking…',
  up: 'Operational',
  slow: 'Slow',
  down: 'Not responding',
};

async function probe(url: string): Promise<{ state: State; ms: number | null }> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Math.round(performance.now() - started);
    if (!response.ok) return { state: 'down', ms };
    return { state: ms > SLOW_MS ? 'slow' : 'up', ms };
  } catch {
    return { state: 'down', ms: null };
  }
}

export function Status() {
  const [checks, setChecks] = useState<Check[]>(() =>
    CHECKS.map((check) => ({ ...check, state: 'checking', ms: null })),
  );
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const run = useCallback(async () => {
    setChecks((current) => current.map((check) => ({ ...check, state: 'checking', ms: null })));
    const results = await Promise.all(CHECKS.map((check) => probe(check.url)));
    setChecks(CHECKS.map((check, index) => ({ ...check, ...results[index]! })));
    setCheckedAt(new Date());
  }, []);
  useEffect(() => {
    void run();
  }, [run]);

  const done = checks.every((check) => check.state !== 'checking');
  const overall: State = !done
    ? 'checking'
    : checks.some((check) => check.state === 'down')
      ? 'down'
      : checks.some((check) => check.state === 'slow')
        ? 'slow'
        : 'up';
  const summary: Record<State, string> = {
    checking: 'Checking Central City…',
    up: 'All systems operational',
    slow: 'Central City is responding slowly',
    down: 'Central City is having problems',
  };

  return (
    <>
      <p className="trust-lead">
        Live health checks for Central City services and APIs, run directly from your browser.
      </p>
      <p className={`trust-status-summary is-${overall}`} role="status" aria-live="polite">
        <span className="trust-status-dot" aria-hidden="true" />
        {summary[overall]}
      </p>
      <ul className="trust-checks">
        {checks.map((check) => (
          <li key={check.id} data-check={check.id} data-state={check.state}>
            <span className="trust-check-info">
              <span className="trust-check-name">{check.label}</span>
              <code className="trust-check-endpoint">GET {check.url}</code>
            </span>
            <span className={`trust-check-state is-${check.state}`}>
              <span className="trust-check-dot" aria-hidden="true" />
              {WORDS[check.state]}
              {check.ms !== null ? <span className="trust-check-ms"> · {check.ms} ms</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="trust-status trust-status-bar">
        {checkedAt ? `Checked from your browser at ${checkedAt.toLocaleTimeString()}. ` : null}
        <button
          type="button"
          className="button secondary"
          onClick={() => void run()}
          disabled={!done}
        >
          Check again
        </button>
      </p>

      <h2>Report an outage</h2>
      <p>
        If something is not working, email <Mail to={SUPPORT_EMAIL} /> with what you tried, the
        time, and any error message. If this page itself does not load, the website is down.
      </p>
    </>
  );
}
