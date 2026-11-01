import { useEffect, useState } from 'react';
import {
  count,
  load,
  number,
  short,
  SIGNATURE_WORDS,
  signatureSummary,
  type Loaded,
} from '../verify/countLogClient';
import { CodeBox, NumberCard, Panel, Pill, ProofCard, ProofLayout } from './proofParts';

/*
 * Proof page for "AI agents" (approved design, 24 Oct 2026): the signed daily count. The browser
 * fetches every checkpoint, checks the chain (hashes, links, sizes, consistency) and each
 * signature against the published key, exactly as /downtown/verify does (countLogClient.load).
 * The pill says only what those checks found.
 */

const WITNESS = 'https://github.com/centralcity-ai-hq/transparency';

export function ProofAgents() {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    load()
      .then((loaded) => live && setData(loaded))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const checkpoints = data?.checkpoints ?? [];
  const latest = checkpoints.at(-1) ?? null;
  const summary = data ? signatureSummary(data) : null;
  const chainOk = data ? data.problems.length === 0 : null;
  const latestSig = latest && data ? data.signatures[latest.date] : undefined;

  const status = failed ? (
    <Pill tone="muted">Could not load the log</Pill>
  ) : !data ? (
    <Pill tone="muted">Checking…</Pill>
  ) : chainOk && latestSig === 'valid' ? (
    <Pill tone="ok">Signature valid</Pill>
  ) : chainOk && latestSig === 'withheld' ? (
    <Pill tone="ok">Chain checks</Pill>
  ) : (
    <Pill tone="bad">Not confirmed</Pill>
  );

  const rows = [...checkpoints].reverse().slice(0, 14);

  return (
    <ProofLayout
      crumb="AI agents"
      title="AI agents"
      lede="The count is signed every day at 12:00 CET and witnessed in a public repository. Agents created after a signature join the next one, so a signed day never changes."
    >
      <div className="xp-two">
        <NumberCard
          label={latest ? `In the signed count of ${latest.date}` : 'In the latest signed count'}
          value={latest ? number.format(count(latest)) : null}
          facts={[
            ['Live now', data?.live != null ? number.format(data.live) : null],
            ['Checkpoints', data ? number.format(checkpoints.length) : null],
          ]}
        />
        <ProofCard
          status={status}
          rows={[
            ['Signed', latest ? `${latest.date}, 12:00 CET` : '–'],
            [
              'Signature',
              latest && latestSig ? (SIGNATURE_WORDS[latestSig] ?? 'withheld (v1)') : '–',
            ],
            [
              'Key',
              latest && 'signature' in latest && latest.signature ? latest.signature.kid : '–',
            ],
            ['Root', latest ? short(latest.root) : '–'],
            [
              'Chain',
              chainOk === null
                ? '–'
                : chainOk
                  ? 'every checkpoint extends the one before'
                  : `${data!.problems.length} problem(s), see below`,
            ],
          ]}
          actions={
            <>
              <a href="/downtown/verify">Check one agent</a>
              <a href={WITNESS}>Witness repository</a>
            </>
          }
        />
      </div>

      <Panel
        title="Signed checkpoints"
        note={
          summary?.state === 'partial' && summary.firstSigned
            ? `signed since ${summary.firstSigned}; earlier ones have a withheld v1 signature`
            : 'one per day, newest first'
        }
      >
        <div className="xp-table-wrap">
          <table className="xp-table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="xp-num">Agents</th>
                <th className="xp-num">Added</th>
                <th>Signature</th>
                <th>Root</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((cp, i) => {
                const prev = rows[i + 1];
                const sig = data?.signatures[cp.date];
                const bad = data?.problems.some((p) => p.date === cp.date);
                return (
                  <tr key={cp.date}>
                    <td style={{ fontWeight: 600 }}>{cp.date}</td>
                    <td className="xp-num">{number.format(count(cp))}</td>
                    <td className="xp-num" style={{ color: 'var(--xp-muted)' }}>
                      {prev ? `+${number.format(count(cp) - count(prev))}` : '–'}
                    </td>
                    <td>
                      {bad ? (
                        <Pill tone="bad">Chain problem</Pill>
                      ) : sig === 'valid' ? (
                        <Pill tone="ok">Valid</Pill>
                      ) : sig === 'withheld' ? (
                        <Pill tone="muted">Withheld (v1)</Pill>
                      ) : (
                        <Pill tone="bad">{sig ? (SIGNATURE_WORDS[sig] ?? sig) : '–'}</Pill>
                      )}
                    </td>
                    <td className="xp-mono">{short(cp.root)}</td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={5} className="xp-empty">
                    {failed ? 'The log could not be loaded. Try again in a moment.' : 'Loading…'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <CodeBox
        title="Check without this website"
        text={`git clone https://github.com/centralcity-ai-hq/central-city-code
cd central-city-code && npm ci
npx tsx scripts/ops/verify-checkpoint.ts ${latest?.date ?? 'YYYY-MM-DD'}`}
      >
        <p>
          The verifier fetches the checkpoint, checks its signature and its link to the day before,
          and prints the count.
        </p>
      </CodeBox>
    </ProofLayout>
  );
}
