import { Component, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { CityMark } from '../brand';
import {
  chunkReloadAvailable,
  isChunkLoadError,
  reloadAfterChunkFailure,
  requestChunkReload,
} from './chunkReload';
import { releasePrerendered } from './prerendered';
import './shell.css';

export { isChunkLoadError } from './chunkReload';

/**
 * Error boundary. A chunk-load failure (a deploy replaced the chunk this tab still refers to)
 * reloads the page with the shared guard in src/shell/chunkReload.ts (up to three reloads within
 * a minute, never a loop) and says a new version is loading meanwhile. Anything else, or a chunk
 * failure after those reloads, shows "Something went wrong" with a Reload (Try again for a render
 * error) button and the error code and time under Details.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; at: Date | null; reloading: boolean }
> {
  state = { error: null as unknown, at: null as Date | null, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    // Decided before the first fallback render, so the error copy never shows while a reload
    // is still to come (pure: only reads the guard).
    const reloading = isChunkLoadError(error) && chunkReloadAvailable();
    return { error, at: new Date(), reloading };
  }

  componentDidCatch(error: unknown) {
    releasePrerendered();
    if (!isChunkLoadError(error) || !this.state.reloading) return;
    if (!requestChunkReload(error)) this.setState({ reloading: false });
  }

  render() {
    const { error, at, reloading } = this.state;
    if (!error) return this.props.children;
    if (reloading)
      return (
        <div className="boot-screen" role="status">
          <CityMark />
          <p className="boot-title">Central City</p>
          <p>
            <LoaderCircle className="spin" size={15} aria-hidden="true" />A new version of Central
            City is available. Reloading…
          </p>
        </div>
      );
    const chunk = isChunkLoadError(error);
    const code = chunk ? 'chunk_load_failed' : 'render_failed';
    return (
      <main id="main-content" tabIndex={-1} className="public-main cc-state-page">
        <section className="cc-state" role="alert" aria-labelledby="error-title">
          <h1 id="error-title">Something went wrong.</h1>
          <p>We couldn’t load this page. Try again in a moment.</p>
          <button
            type="button"
            className="button primary large"
            onClick={() => (chunk ? reloadAfterChunkFailure(error) : window.location.reload())}
          >
            {chunk ? 'Reload' : 'Try again'}
          </button>
          <details className="cc-state-details">
            <summary>Details</summary>
            <p>
              <code>{code}</code> · <time dateTime={at?.toISOString()}>{at?.toISOString()}</time>
            </p>
          </details>
        </section>
      </main>
    );
  }
}
