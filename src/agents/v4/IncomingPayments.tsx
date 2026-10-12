import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import {
  createIncomingFeed,
  receivedStatus,
  type PayIncomingRow,
  type ReceivedStatus,
} from '../../base/wallet/pay';
import { shortHex } from './WithdrawalStatus';

/*
 * Payments other agents send this one (Operation Base Pay P1), as the server reads them
 * (GET /api/base/pay/incoming), read again every POLL_MS while the screen is open and shown. Only
 * 'final' is paid; one on its way is never shown as money to count on, and one that failed says so. The payer's name is display only: its Base ID or wallet
 * identifies it. Nothing shows while the read fails or Pay is off. Once the server says Base settled
 * it at its safe head (`safe`), the money has arrived: "Received · awaiting finality", never final
 * before final. Each row reads as its latest answer, so it never keeps an earlier "Received".
 */

const SHOWN = 5;
/** While the screen is open and shown: a new payment or a state change shows within this. */
const POLL_MS = 20_000;
/** A backlog still waiting (more than a refresh's pages): the next pages come sooner. */
const BACKLOG_MS = 10_000;
/** Too many reads (429): wait a minute. */
const BACKOFF_MS = 60_000;

const payerOf = (payment: PayIncomingRow) =>
  payment.from.name.trim() ||
  (payment.from.short ? `CC-${payment.from.short}` : shortHex(payment.from.wallet));

function line(payment: PayIncomingRow, status: ReceivedStatus, name: string) {
  const payer = payerOf(payment);
  // Arrived at Base's safe head: it was sent, it isn't still on its way.
  if (status.phase === 'received') return `${payer} sent ${name}`;
  switch (payment.state) {
    case 'final':
      return `${payer} paid ${name}`;
    case 'failed':
      return `${payer}’s payment didn’t go through`;
    default:
      return `${payer} is sending ${name}`;
  }
}

export function IncomingPayments({ agentId, name }: { agentId: string; name: string }) {
  const [payments, setPayments] = useState<PayIncomingRow[]>([]);
  useEffect(() => {
    // One feed for this agent's screen: it keeps its cursor and every payment's latest state.
    const feed = createIncomingFeed();
    let stop = false;
    let running = false;
    let timer = 0;
    const later = (ms: number) => {
      window.clearTimeout(timer);
      if (!stop) timer = window.setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      // Hidden: no reads; it picks up again when the page is shown.
      if (stop || running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const { payments: all, more } = await feed.refresh();
        if (stop) return;
        setPayments(
          all
            .filter((payment) => payment.to?.agentId === agentId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, SHOWN),
        );
        later(more ? BACKLOG_MS : POLL_MS);
      } catch (error) {
        // Pay off here (404): nothing to show, nothing to poll. Too many reads: wait longer.
        if (error instanceof ApiError && error.status === 404) return;
        later(error instanceof ApiError && error.status === 429 ? BACKOFF_MS : POLL_MS);
      } finally {
        running = false;
      }
    };
    const shown = () => {
      if (document.visibilityState === 'visible') later(0);
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
      <p className="w4-section">Payments to {name}</p>
      <div className="ap4-group w4-list" aria-label={`Payments to ${name}`}>
        {payments.map((payment) => {
          const status = receivedStatus(payment);
          return (
            <div
              className="ap4-row v4s-still"
              key={payment.paymentId}
              data-state={payment.state}
              data-phase={status.phase}
            >
              <span className="ap4-k">
                {line(payment, status, name)}
                {status.headline ? <span className="w4-row-state">{status.headline}</span> : null}
                {/* The money arrived; final is minutes away. No countdown: Base decides when. */}
                {status.note ? <span className="w4-row-sub">{status.note}</span> : null}
                <span className="w4-row-sub">
                  {payment.from.baseId ? `Base ID ${payment.from.baseId}` : 'Base ID not final yet'}
                  {status.onItsWay ? ' · on its way, not paid until final' : ''}
                  {/* A note shows once the payment is final: never from one that didn't land. */}
                  {payment.note && payment.state === 'final' ? ` · “${payment.note}”` : ''}
                  {' · '}
                  {new Date(payment.finalAt ?? payment.updatedAt).toLocaleDateString('en-US', {
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
              <span
                className={`w4-amt${status.amount === 'in' ? ' in' : status.amount === 'off' ? ' w4-off' : ''}`}
              >
                {status.amount === 'in' ? '+' : ''}
                {payment.amount.display}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
