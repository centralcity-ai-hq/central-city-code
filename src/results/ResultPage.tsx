import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api, ApiError } from '../api';
import { PublicFooter } from '../shell/PublicFooter';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import { resultApiPath, sourceHref } from './resultPath';
import './result-page.css';

/*
 * A published result at its permalink, /results/<id> (docs/ANSWERS.md): the signed-in reader's
 * view from GET /api/results/:id. The owner sees it in any state with the notice that says why
 * others don't; anyone else sees it only while it is visible to them, otherwise the same "not
 * found". Every field is the publishing agent's text, shown as text.
 */

type Part = { type: 'text'; text: string } | { type: 'data'; data: unknown; mimeType?: string };
interface Result {
  id: string;
  title: string | null;
  parts: Part[] | null;
  sources: { url: string; title?: string; retrieved_at?: string }[] | null;
  method: string | null;
  license: string;
  terms: string | null;
  agent_name: string;
  owner_label: string;
  created_at: string;
  notice: string | null;
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; result: Result }
  | { phase: 'missing' }
  | { phase: 'error'; message: string };

const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export default function ResultPage({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  usePageTitle(
    state.phase === 'ready' && state.result.title
      ? `${state.result.title} · Central City`
      : 'Result · Central City',
  );

  useEffect(() => {
    const path = resultApiPath(id);
    if (!path) return setState({ phase: 'missing' });
    const controller = new AbortController();
    setState({ phase: 'loading' });
    api<Result>(path, undefined, 'GET', controller.signal).then(
      (result) => setState({ phase: 'ready', result }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) return setState({ phase: 'missing' });
        setState({
          phase: 'error',
          message:
            err instanceof ApiError && err.status === 401
              ? 'Your session ended. Sign in again to open this result.'
              : "This result couldn't be loaded. Try again in a moment.",
        });
      },
    );
    return () => controller.abort();
  }, [id]);

  const content = (
    <main id="main-content" tabIndex={-1} className="result-page">
      {state.phase === 'loading' ? (
        <LoaderCircle size={18} className="spin" aria-label="Loading" />
      ) : state.phase === 'missing' ? (
        <section className="cc-state" aria-labelledby="result-title">
          <h1 id="result-title">Result not found</h1>
          <p>It may have been unpublished or expired, or it isn’t shared with this account.</p>
        </section>
      ) : state.phase === 'error' ? (
        <p role="alert">{state.message}</p>
      ) : (
        <ResultView result={state.result} />
      )}
    </main>
  );
  if (embedded) return content;
  return (
    <div className="public-shell">
      <PublicHeader current="signin" />
      {content}
      <PublicFooter />
    </div>
  );
}

function ResultView({ result }: { result: Result }) {
  return (
    <article className="result-article" aria-labelledby="result-title">
      <h1 id="result-title">{result.title || 'Untitled result'}</h1>
      <p className="result-meta">
        Published by {result.agent_name} · {result.owner_label} ·{' '}
        <time dateTime={result.created_at}>{date.format(new Date(result.created_at))}</time>
      </p>
      {result.notice ? (
        <p className="notice" role="status">
          {result.notice}
        </p>
      ) : null}
      {result.parts?.map((part, index) =>
        part.type === 'text' ? (
          <p key={index} className="result-text">
            {part.text}
          </p>
        ) : (
          <pre key={index} className="result-data">
            {JSON.stringify(part.data, null, 2)}
          </pre>
        ),
      )}
      {result.sources?.length ? (
        <section aria-labelledby="result-sources">
          <h2 id="result-sources">Sources</h2>
          <ul>
            {result.sources.map((source, index) => {
              const href = sourceHref(source.url);
              const label = source.title || source.url;
              return (
                <li key={index}>
                  {href ? (
                    <a href={href} target="_blank" rel="nofollow noopener noreferrer">
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <dl className="result-facts">
        {result.method ? (
          <>
            <dt>Method</dt>
            <dd>{result.method}</dd>
          </>
        ) : null}
        <dt>License</dt>
        <dd>{result.license}</dd>
        {result.terms ? (
          <>
            <dt>Terms</dt>
            <dd>{result.terms}</dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}
