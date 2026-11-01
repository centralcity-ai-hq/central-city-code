import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api, ApiError } from '../api';
import { NotFound } from '../shell/NotFound';
import { usePageTitle } from '../shell/usePageTitle';
import '../shell/shell.css';

/*
 * /owner/sponsor-eth: the owner's one click (server/feed/pay/sponsor-eth-sweep.ts). Hidden, never
 * linked, noindex. The server answers 404 to everyone but a proven sponsor operator, and so does
 * this page.
 */

interface Summary {
  from: string;
  to: string;
  balanceEth: string;
  reserveEth: string;
  amountEth: string;
  canSend: boolean;
  reason: string | null;
  pendingTx: string | null;
}
interface Sent {
  txHash: string;
  amountEth: string;
  basescan: string;
}

const PATH = '/api/owner/sponsor-eth-to-facilitator';
const REASONS: Record<string, string> = {
  pending: 'A previous move is still pending.',
  sponsor_busy: 'The sponsor has transactions in flight. Reload in a minute.',
  gas_too_high: 'Gas is unusually high now. Try later.',
  below_minimum: 'Less than 0.005 ETH would move.',
};

export function SponsorEthPage() {
  usePageTitle('Sponsor ETH · Central City');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<'loading' | 'hidden' | 'ready' | 'busy' | 'sent' | 'error'>(
    'loading',
  );
  const [sent, setSent] = useState<Sent | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api<Summary>(PATH, undefined, 'GET')
      .then((value) => {
        setSummary(value);
        setState('ready');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setState('hidden');
        else {
          setMessage(err instanceof Error ? err.message : 'Could not load.');
          setState('error');
        }
      });
  }, []);

  async function move() {
    setState('busy');
    try {
      setSent(await api<Sent>(PATH, {}));
      setState('sent');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'That did not go through.');
      setState('error');
    }
  }

  if (state === 'hidden') return <NotFound />;
  return (
    <main id="main-content" tabIndex={-1} className="public-main cc-state-page">
      <section className="cc-state cc-not-found" aria-labelledby="sponsor-eth-title">
        <h1 id="sponsor-eth-title">Sponsor ETH</h1>
        {state === 'loading' ? (
          <LoaderCircle size={17} className="spin" aria-hidden="true" />
        ) : null}
        {summary ? (
          <dl>
            <dt>Sponsor</dt>
            <dd>
              <code>{summary.from}</code>
            </dd>
            <dt>Balance</dt>
            <dd>{summary.balanceEth} ETH</dd>
            <dt>Reserve kept</dt>
            <dd>{summary.reserveEth} ETH</dd>
            <dt>Facilitator</dt>
            <dd>
              <code>{summary.to}</code>
            </dd>
          </dl>
        ) : null}
        {state === 'sent' && sent ? (
          <p role="status">
            Sent {sent.amountEth} ETH. <code>{sent.txHash}</code>{' '}
            <a href={sent.basescan} target="_blank" rel="noreferrer">
              Basescan
            </a>
          </p>
        ) : null}
        {state === 'error' ? <p role="alert">{message}</p> : null}
        {summary && state !== 'sent' ? (
          summary.canSend ? (
            <div className="cc-not-found-actions">
              <button
                type="button"
                className="button primary large"
                disabled={state !== 'ready'}
                onClick={() => void move()}
              >
                {state === 'busy' ? (
                  <LoaderCircle size={17} className="spin" aria-hidden="true" />
                ) : null}
                Move {summary.amountEth} ETH to facilitator
              </button>
            </div>
          ) : (
            <p role="status">
              {REASONS[summary.reason ?? ''] ?? 'Nothing to move now.'}
              {summary.pendingTx ? (
                <>
                  {' '}
                  <a
                    href={`https://basescan.org/tx/${summary.pendingTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Basescan
                  </a>
                </>
              ) : null}
            </p>
          )
        ) : null}
      </section>
    </main>
  );
}
