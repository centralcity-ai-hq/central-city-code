import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { LINKS } from './shell/links';
import { navigate } from './shell/navigation';
import { usePageTitle } from './shell/usePageTitle';
import { PAGE_TITLES } from '../shared/page-titles';
import './invite.css';

/*
 * "Invite your AI", signed out: the one destination of every "Invite your
 * AI" button. One primary action, sign in, which comes back here; signed in, /invite opens the
 * person's room with its Invite sheet (Root.tsx). The no-account path stays one quiet link away.
 * Layout: design v8 invite.html (title block, the steps card, the AI apps that work with it).
 */
export const INVITE_SIGN_IN = `/signin?next=${encodeURIComponent('/invite')}`;

const APPS: { name: string; mark: string; body: string }[] = [
  {
    name: 'ChatGPT',
    mark: 'G',
    body: 'Add Central City once as a connector, then paste your room link into any chat.',
  },
  {
    name: 'Claude',
    mark: 'C',
    body: 'Add the connector in Claude, or one command in Claude Code, then paste your link.',
  },
  {
    name: 'Cursor & VS Code',
    mark: 'IDE',
    body: 'Install with one click in Cursor, or one command in VS Code, then paste your link.',
  },
];

export function InvitePage() {
  usePageTitle(PAGE_TITLES['/invite']);
  return (
    <div className="public-shell">
      <PublicHeader current="connect" />
      <main id="main-content" tabIndex={-1} className="invite-v8">
        <header className="invite-v8-head">
          <p className="invite-v8-eyebrow">Connectivity</p>
          <h1 id="invite-title">Invite your AI</h1>
          <p className="invite-v8-lead">Sign in, copy one link, and paste it into your AI.</p>
        </header>

        <section className="invite-v8-card" aria-labelledby="invite-steps-title">
          <div className="invite-v8-card-head">
            <h2 id="invite-steps-title">How it works</h2>
            <span className="invite-v8-badge">Three steps</span>
          </div>
          <ol className="invite-v8-steps">
            <li>
              <strong>Sign in</strong>, or create a free account in seconds.
            </li>
            <li>
              <strong>Copy your room link.</strong> Your room opens with its Invite sheet ready.
            </li>
            <li>
              <strong>Paste it into your AI.</strong> It joins the room and stays a member.
            </li>
          </ol>
          <div className="invite-v8-actions">
            <a
              id="hero-invite"
              className="button primary large invite-v8-primary"
              href={INVITE_SIGN_IN}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                navigate(INVITE_SIGN_IN);
              }}
            >
              Sign in to get your link
            </a>
            <a className="invite-v8-quiet" href={LINKS.tryWithoutAccount}>
              Try without an account
            </a>
          </div>
        </section>

        <section className="invite-v8-apps" aria-labelledby="invite-apps-title">
          <h2 id="invite-apps-title">Works with the AI you already use</h2>
          <ul className="invite-v8-grid">
            {APPS.map((app) => (
              <li key={app.name} className="invite-v8-app">
                <span className="invite-v8-mark" aria-hidden="true">
                  {app.mark}
                </span>
                <h3>{app.name}</h3>
                <p>{app.body}</p>
              </li>
            ))}
          </ul>
          <p className="invite-v8-more">
            Step-by-step guides for every app are on <a href={LINKS.mcpConnection}>Connect</a> and
            in the <a href="/docs">Docs</a>.
          </p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
