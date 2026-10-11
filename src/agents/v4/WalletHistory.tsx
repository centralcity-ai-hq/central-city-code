import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import type { WalletView } from '../../base/wallet/api';
import { usePasswordLock } from '../../base/wallet/usePasswordLock';
import {
  askCancel,
  cancelSignaturePath,
  checkOperation,
  checkSigningWindow,
  DONE,
  dropLaneRecord,
  dropReleased,
  laneRefusal,
  readLaneRecords,
  readOpenWithdrawals,
  readReleased,
  readWithdrawal,
  signAndSend,
  WithdrawalCheckError,
  type LaneRecord,
  type WithdrawalAnchor,
  type WithdrawalView,
} from '../../base/wallet/withdraw';
import {
  explorerOf,
  merged,
  nextSweep,
  nounOf,
  pollDelay,
  sameHash,
  SHOWN_MAX,
  stateOf,
  textOf,
  toReadAlone,
  visibleLines,
  type Line,
} from './walletHistoryModel';
import { ErrorLine, PasswordField, signingFailure } from './WithdrawalStatus';

/*
 * History (pay without waiting, lanes on): every operation from this wallet that is on its way, as
 * one line each, newest first. A payment never holds the screen: once signed the form is empty
 * again and its line moves on by itself ("On its way" → "Sent · awaiting finality" → "Paid ✓").
 *
 * One read per tick, of the server's open list (?open=1): every 3 s while one is on its way, about
 * every 12 s once all are settled at Base's safe head, none while the page is hidden, and none once
 * nothing is open. An operation that leaves the list is read once by itself, to say how it ended
 * (and if the list can't be read, what this browser signed is read that way). Once done, a line
 * shows how it ended for a little while, then leaves for the wallet's own history.
 * The lines name what this browser kept when it signed (src/base/wallet/withdraw.ts LaneRecord);
 * a line is cancelled from here only when this browser signed it and Base hasn't taken it yet.
 */

/** A POST answer's `safe` never counts (the server sets it there only when final). */
const posted = (view: WithdrawalView): WithdrawalView => ({ ...view, safe: undefined });

/** What the parent signed just now: its POST answer and its record, shown at once. */
export interface SignedNow {
  view: WithdrawalView;
  record: LaneRecord;
}

export function WalletHistory({
  agentId,
  wallet,
  signed,
  hidden = false,
}: {
  agentId: string;
  wallet: WalletView;
  signed: SignedNow | null;
  /** Kept reading but not shown (while a review is on screen). */
  hidden?: boolean;
}) {
  const [lines, setLines] = useState<Array<Line & { done: boolean }>>([]);
  /** `done`: when each finished line was first seen done (it leaves DONE_SHOWN_MS later). */
  const store = useRef({ lines: new Map<string, Line>(), done: new Map<string, number>() });
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    let stop = false;
    let timer = 0;
    let running = false;
    let again = false;
    const { lines: known, done } = store.current;

    const put = (
      view: WithdrawalView,
      record: LaneRecord | undefined,
      payment?: WithdrawalAnchor['payment'],
      at?: number,
    ) => {
      known.set(view.withdrawalId, merged(known.get(view.withdrawalId), view, record, payment, at));
    };
    const finish = (id: string) => {
      if (!done.has(id)) done.set(id, Date.now());
      dropLaneRecord(agentId, id);
      dropReleased(agentId, id);
    };
    let sweep = 0;
    const render = () => {
      // Finished a while ago: into the wallet's own history (gone from here, still known as done).
      setLines(visibleLines(known, done));
      window.clearTimeout(sweep);
      const next = nextSweep(known, done);
      if (next !== null && !stop) sweep = window.setTimeout(render, next);
    };

    /** One read of an operation that isn't in the open list: how it ended, or that it's unknown. */
    const readOne = async (id: string) => {
      const record = readLaneRecords(agentId).find((entry) => entry.withdrawalId === id);
      const released = readReleased(agentId).find((entry) => entry.withdrawalId === id);
      try {
        const view = await readWithdrawal(agentId, id);
        if (stop || view.withdrawalId !== id) return;
        // Another operation than the one signed here under this id: never shown as it.
        const ours = (record && sameHash(record, view)) || (released && sameHash(released, view));
        if (!ours && !known.has(id)) return finish(id);
        put(view, record, released?.payment, released?.releasedAt);
        if (DONE.includes(view.state)) finish(id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          known.delete(id);
          finish(id);
        }
        // Any other miss: the line keeps what it last read.
      }
    };

    const tick = async () => {
      if (stop) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      window.clearTimeout(timer);
      let listed = true;
      try {
        const open = await readOpenWithdrawals(agentId).catch(() => null);
        if (stop) return;
        listed = open !== null;
        const records = readLaneRecords(agentId);
        // The list can't be read (lanes turned off since, say): what this browser signed, and
        // what is shown, is read one by one, a few per tick.
        let inList: Set<string> | null = null;
        if (open) {
          inList = new Set<string>();
          for (const view of open) {
            // Prepared and not signed (on a review screen, say): nothing is on its way yet.
            if (view.state === 'awaiting_signature' || done.has(view.withdrawalId)) continue;
            inList.add(view.withdrawalId);
            const record = records.find((entry) => entry.withdrawalId === view.withdrawalId);
            if (record && !sameHash(record, view)) dropLaneRecord(agentId, record.withdrawalId);
            put(view, record);
          }
        }
        // What left the list (or never showed in it) is read once by itself, a few per tick.
        const kept = [...records, ...readReleased(agentId)];
        await Promise.all(toReadAlone(known, done, inList, kept).map(readOne));
        if (stop) return;
        render();
      } finally {
        running = false;
        if (!stop) {
          if (again) {
            again = false;
            void tick();
          } else schedule(listed);
        }
      }
    };

    const schedule = (listed: boolean) => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'hidden') return;
      const keptOpen = [...readLaneRecords(agentId), ...readReleased(agentId)].some(
        (entry) => !done.has(entry.withdrawalId),
      );
      // Nothing open: no more reads until something is signed or the screen opens again.
      const delay = pollDelay(known, done, keptOpen, listed);
      if (delay !== null) timer = window.setTimeout(() => void tick(), delay);
    };

    const visible = () => {
      if (document.visibilityState === 'hidden') window.clearTimeout(timer);
      else void tick();
    };
    document.addEventListener('visibilitychange', visible);
    kick.current = () => void tick();
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      window.clearTimeout(sweep);
      document.removeEventListener('visibilitychange', visible);
      kick.current = () => {};
    };
  }, [agentId]);

  // Signed just now: its line shows at once, and the list is read again.
  useEffect(() => {
    if (!signed) return;
    const { lines: known, done } = store.current;
    const id = signed.view.withdrawalId;
    done.delete(id);
    known.set(id, {
      view: posted(signed.view),
      record: signed.record,
      payment: signed.record.payment,
      at: signed.record.signedAt,
    });
    setLines(visibleLines(known, done));
    kick.current();
  }, [signed]);

  if (!lines.length || hidden) return null;
  const shown = lines.slice(0, SHOWN_MAX);
  const more = lines.slice(SHOWN_MAX).filter((line) => !line.done).length;
  return (
    <div className="w4-history">
      <p className="w4-section">History</p>
      <ul className="w4-history-lines" aria-label="History">
        {shown.map((line) => (
          <HistoryLine
            key={line.view.withdrawalId}
            agentId={agentId}
            wallet={wallet}
            line={line}
            onChange={(view) => {
              const { lines: known } = store.current;
              const before = known.get(view.withdrawalId);
              if (before) known.set(view.withdrawalId, { ...before, view: posted(view) });
              kick.current();
            }}
          />
        ))}
      </ul>
      {more > 0 ? (
        <p className="w4-hint" data-k="more">
          and {more} more on their way
        </p>
      ) : null}
    </div>
  );
}

function HistoryLine({
  agentId,
  wallet,
  line,
  onChange,
}: {
  agentId: string;
  wallet: WalletView;
  line: Line;
  onChange: (view: WithdrawalView) => void;
}) {
  const { view, record } = line;
  const noun = nounOf(line);
  const status = stateOf(line);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { password, setPassword, alive } = usePasswordLock(busy);
  // Only one this browser signed, before Base took it, and never once a cancel was asked.
  const cancellable = !!record && view.state === 'submitted' && !view.cancel;

  async function cancel(event: FormEvent) {
    event.preventDefault();
    if (!record || !wallet.address) return;
    setError('');
    setBusy(true);
    // Marked before anything else: if the password goes while the cancel is asked, nothing is sent.
    const mark = alive();
    try {
      // Only ever the operation this browser checked and signed: the server's copy isn't evidence.
      if (!sameHash(record, view))
        throw new WithdrawalCheckError(`The ${noun} on its way isn’t the one signed here.`);
      const asked = await askCancel(agentId, view.withdrawalId);
      const noop = asked.cancel;
      if (!noop?.userOperation) throw new Error(`This ${noun} can’t be cancelled any more.`);
      const hash = checkOperation({
        userOperation: noop.userOperation,
        userOpHash: noop.userOpHash,
        entryPoint: noop.entryPoint,
        chainId: asked.chainId,
        wallet: wallet.address,
        owner: wallet.ownerAddress,
        agentId,
        expected: { kind: 'noop', original: record },
        // In the original's own lane, at exactly its nonce (one from before lanes: its nonce).
        lanes: record.laned,
        lane: record.laned ? { withdrawalId: record.withdrawalId } : undefined,
      });
      const window = {
        lanes: record.laned,
        chainId: asked.chainId,
        expiresAt: noop.expiresAt,
        userOperation: noop.userOperation,
      };
      checkSigningWindow(window);
      const answer = await signAndSend(
        cancelSignaturePath(agentId, view.withdrawalId),
        hash,
        password,
        mark,
        () => checkSigningWindow(window),
        wallet.ownerAddress,
      );
      setPassword('');
      setOpen(false);
      onChange(answer);
    } catch (err) {
      setPassword('');
      setError(laneRefusal(err, { noun, token: view.token }) ?? signingFailure(err));
    } finally {
      setBusy(false);
    }
  }
  const explorer = explorerOf(view);

  return (
    <li data-phase={status.phase} data-id={view.withdrawalId}>
      <div className="w4-hline">
        <span data-k="line">
          {textOf(line)} · {status.short}
        </span>
        {explorer ? (
          <a
            className="w4-textbtn"
            href={explorer}
            target="_blank"
            rel="noreferrer"
            aria-label={`View ${textOf(line)} on Basescan`}
          >
            Basescan
          </a>
        ) : null}
        {cancellable && !open ? (
          <button
            type="button"
            className="w4-textbtn"
            aria-label={`Cancel ${textOf(line)}`}
            onClick={() => setOpen(true)}
          >
            Cancel
          </button>
        ) : null}
      </div>
      {cancellable && open ? (
        <form className="w4-steps w4-hcancel" onSubmit={(event) => void cancel(event)}>
          <p className="w4-hint">
            To cancel, you sign a no-op at the same place; whichever Base takes first wins, so the{' '}
            {noun} may still land. If the cancellation fee cannot be covered, nothing is signed or
            charged for the cancellation.
          </p>
          <PasswordField value={password} onChange={setPassword} />
          <ErrorLine message={error} />
          <div className="ap4-actions">
            <button
              type="submit"
              className="ap4-btn ap4-ghost"
              disabled={busy || !password}
              aria-busy={busy}
            >
              {busy ? 'Signing…' : 'Sign the cancel'}
            </button>
            <button
              type="button"
              className="ap4-btn ap4-ghost"
              disabled={busy}
              onClick={() => {
                setPassword('');
                setError('');
                setOpen(false);
              }}
            >
              Keep it
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
