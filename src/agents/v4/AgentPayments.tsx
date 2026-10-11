import { useEffect, useState } from 'react';
import { readAgentPayments, type PayByAgent } from '../../base/wallet/pay';
import { shortHex } from './WithdrawalStatus';

/*
 * Payments the agent made on its own (Base Pay P2: from its own wallet, within the spending limit
 * its owner signed), as the server last recorded them (GET .../wallet/agent-payments). Read again
 * every POLL_MS while the screen is open and shown. Only 'final' is paid; one on its way is never
 * shown as paid, and one that failed says so. The recipient's name is display only: its Base ID
 * or wallet identifies it. Nothing shows while the read fails, wallets are off or there are none.
 */

const SHOWN = 5;
const POLL_MS = 20_000;

const payeeOf = (payment: PayByAgent) =>
  payment.to.name.trim() ||
  (payment.to.short ? `CC-${payment.to.short}` : shortHex(payment.to.wallet));

function line(payment: PayByAgent) {
  const payee = payeeOf(payment);
  switch (payment.state) {
    case 'final':
      return `Paid ${payee}`;
    case 'failed':
      return `Payment to ${payee} didn’t go through`;
    default:
      return `Paying ${payee}`;
  }
}

export function AgentPayments({ agentId, name }: { agentId: string; name: string }) {
  const [payments, setPayments] = useState<PayByAgent[]>([]);
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      window.clearTimeout(timer);
      if (stop || document.visibilityState === 'hidden') return;
      try {
        const read = await readAgentPayments(agentId);
        if (stop) return;
        // Off or not this person's wallet (404): nothing to show, nothing to poll.
        if (read === null) return setPayments([]);
        setPayments(read.slice(0, SHOWN));
      } catch {
        // The read failed: what was shown stays, and the next read tries again.
      }
      if (!stop) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    const shown = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', shown);
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [agentId]);

  if (!payments.length) return null;
  return (
    <>
      <p className="w4-section">Payments from {name}</p>
      <div className="ap4-group w4-list" aria-label={`Payments from ${name}`}>
        {payments.map((payment) => (
          <div
            className="ap4-row v4s-still"
            key={payment.paymentId}
            data-state={payment.state}
            data-by={payment.by}
          >
            <span className="ap4-k">
              {line(payment)}
              <span className="w4-row-sub">
                {`By ${name} itself`}
                {/* Only while the records still name the recipient's wallet. */}
                {payment.to.baseId ? ` · Base ID ${payment.to.baseId}` : ''}
                {payment.state === 'pending' || payment.state === 'included'
                  ? ' · on its way, not paid until final'
                  : ''}
                {' · '}
                {new Date(payment.updatedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
                {payment.explorerUrl ? (
                  <>
                    {' · '}
                    <a href={payment.explorerUrl} target="_blank" rel="noreferrer">
                      Basescan
                    </a>
                  </>
                ) : null}
              </span>
            </span>
            <span className={`w4-amt${payment.state === 'final' ? '' : ' w4-off'}`}>
              {payment.state === 'final' ? '−' : ''}
              {payment.amount.display}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
