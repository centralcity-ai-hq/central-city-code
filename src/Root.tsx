import {
  lazy,
  startTransition,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Operator } from '../shared/types';
import type { DocsPageId } from './docs/DocsPages';
import { api, ApiError, selectedWorkspaceId } from './api';
import { forgetAllStatuses } from './base/baseStatusCache';
import { setSignedInPerson } from './base/signedInPerson';
import { Auth } from './Auth';
import type { OnboardingState } from './GoogleAccount';
import { safeReturnPath } from '../shared/return-path';
import { CityMark } from './brand';
import { ErrorBoundary } from './shell/ErrorBoundary';
import { NotFound } from './shell/NotFound';
import { prerendered, releasePrerendered, rememberSignedIn } from './shell/prerendered';
import { INVITE_ROOMS_PATH, isRoomsPath, navigate, setSignedIn } from './shell/navigation';
import { pendingJoinPath, safeNext } from './rooms/pendingJoin';
import { installInAppLinks, pageCommitted, takeInAppChange } from './shell/pageNavigation';
import { prefetchAgentCount } from './agentCount';
import { useWorkspaceV2 } from './shell/workspaceV2';
import { workspaceView, type WorkspaceView } from './shell/workspaceDestinations';
import { workspaceLanding } from './shell/workspaceLanding';
import { ElricSkeleton } from './elric/ElricSkeleton';
import {
  elricDashboardModule,
  readyElric,
  takeElricStatus,
  type ElricDashboardModule,
  type ElricStatus,
} from './elric/prefetch';

/*
 * The entry chunk: session check, hash routing and the 404. Every screen is its own lazily
 * loaded chunk, so the landing page never downloads the console.
 */
import { USE_CASES, USE_CASES_INDEX, useCasePath } from '../shared/use-cases';
const loadLanding = () => import('./Landing');
const loadInvite = () => import('./Invite');
const loadDowntown = () => import('./Downtown');
const loadDocs = () => import('./docs/DocsPages');
const loadVerify = () => import('./verify/VerifyPage');
const loadConnect = () => import('./Connect');
const loadApp = () => import('./App');
const loadRooms = () => import('./RoomsShell');
const loadTrust = () => import('./Trust');
const loadLiveLog = () => import('./verify/LiveLog');
const loadOnBase = () => import('./verify/OnBase');
const loadPassportPage = () => import('./verify/Passport');
const loadWorkflows = () => import('./WorkflowsPage');
const loadUseCases = () => import('./use-cases/UseCasePage');
const loadElricSignedOut = () => import('./elric/ElricSignedOut');
/** The use-case pages: /use-cases and /use-cases/<slug> (shared/use-cases.ts). */
const USE_CASE_PATH = new RegExp(
  `^/use-cases(?:/(${USE_CASES.map((entry) => entry.slug).join('|')}))?/?$`,
);
/**
 * A Base agent's passport: /a/<Base ID> (decimal), the address its tokenURI names, or the
 * on-chain short link /a/<6 base62 characters> (server/base/identity/short-links.ts). The server
 * answers browsers with the app and registry readers with the ERC-8004 file.
 */
/** A passport: /a/<short id>, the address in its Base ID's tokenURI (6 of [0-9A-Za-z]). */
const PASSPORT_PATH = /^\/a\/([0-9A-Za-z]{6})\/?$/;
/** The public trust and company pages (src/Trust.tsx); kept here so the entry chunk stays small. */
const TRUST_PATH =
  /^\/(privacy|privacy-choices|terms|acceptable-use|dpa|imprint|security|support|status|about|contact)\/?$/;
function trustPage(pathname: string) {
  return (TRUST_PATH.exec(pathname)?.[1] ?? null) as import('./Trust').TrustPageId | null;
}
/** Mirrors RoomsShell's CREATE_FIRST_ROOM_STATE (kept here so the entry chunk stays small). */
const CREATE_FIRST_ROOM_STATE = 'createFirstRoom';
const Landing = lazy(() => loadLanding().then((module) => ({ default: module.Landing })));
const InvitePage = lazy(() => loadInvite().then((module) => ({ default: module.InvitePage })));
const Downtown = lazy(() => loadDowntown().then((module) => ({ default: module.Downtown })));
const DocsPage = lazy(() => loadDocs().then((module) => ({ default: module.DocsPage })));
const VerifyPage = lazy(() => loadVerify().then((module) => ({ default: module.VerifyPage })));
// The Live log (/downtown/log): the count log's entries, newest first, with a proof per entry.
const LiveLog = lazy(() => loadLiveLog().then((module) => ({ default: module.LiveLog })));
const OnBase = lazy(() => loadOnBase().then((module) => ({ default: module.OnBase })));
// A Base agent's passport (/a/<id>), On Base's page per agent.
const Passport = lazy(() => loadPassportPage().then((module) => ({ default: module.Passport })));
const ConnectPage = lazy(() => loadConnect().then((module) => ({ default: module.ConnectPage })));
const Workspaces = lazy(() => loadApp().then((module) => ({ default: module.Workspaces })));
// The Rooms experience (/rooms, /rooms/:id, /r/:slug) is its own chunk too.
const RoomsShell = lazy(loadRooms);
const NewsletterLinkPage = lazy(() =>
  import('./NewsletterLink').then((module) => ({ default: module.NewsletterLinkPage })),
);
const TrustPage = lazy(() => loadTrust().then((module) => ({ default: module.TrustPage })));
const WorkflowsPage = lazy(() =>
  loadWorkflows().then((module) => ({ default: module.WorkflowsPage })),
);
const UseCasePage = lazy(() => loadUseCases().then((module) => ({ default: module.UseCasePage })));
const UseCasesIndex = lazy(() =>
  loadUseCases().then((module) => ({ default: module.UseCasesIndex })),
);

/**
 * Starts the likely screen's chunk at startup, in parallel with the session request, so the
 * split adds no extra round trip. The browser caches the module, so React.lazy reuses it.
 */
/** A failed prefetch is reported by the lazy import that follows; don't log it twice. */
const ignorePrefetchFailure = () => undefined;

export function prefetchInitialScreen() {
  if (/^\/downtown\/?$/.test(window.location.pathname))
    return void loadDowntown().catch(ignorePrefetchFailure);
  if (trustPage(window.location.pathname)) return void loadTrust().catch(ignorePrefetchFailure);
  if (/^\/downtown\/verify\/?$/.test(window.location.pathname))
    return void loadVerify().catch(ignorePrefetchFailure);
  if (/^\/docs(?:\/[a-z-]+)?\/?$/.test(window.location.pathname))
    return void loadDocs().catch(ignorePrefetchFailure);
  if (/^\/workflows\/?$/.test(window.location.pathname))
    return void loadWorkflows().catch(ignorePrefetchFailure);
  if (PASSPORT_PATH.test(window.location.pathname))
    return void loadPassportPage().catch(ignorePrefetchFailure);
  if (USE_CASE_PATH.test(window.location.pathname))
    return void loadUseCases().catch(ignorePrefetchFailure);
  if (!knownPath(window.location.pathname)) return;
  if (isRoomsPath(window.location.pathname)) return void loadRooms().catch(ignorePrefetchFailure);
  if (consolePathView(window.location.pathname)) return void loadApp().catch(ignorePrefetchFailure);
  if (/^\/invite\/?$/.test(window.location.pathname))
    return void loadInvite().catch(ignorePrefetchFailure);
  const route = isConnectPath(window.location.pathname) ? 'connect' : routeFromHash();
  // Signed-in visitors land on the console from any hash; the session decides, so a
  // signed-out first visit to / loads only the landing chunk.
  if (route === 'connect') void loadConnect().catch(ignorePrefetchFailure);
  // Sign-in renders from the entry; fetch the console it leads to in the background.
  else if (route === 'signin') void loadApp().catch(ignorePrefetchFailure);
  else {
    void loadLanding().catch(ignorePrefetchFailure);
    // The landing's agent count (an edge-cached public read): requested now, with the session
    // and the landing chunk, so the number is there when the page renders.
    if (route === 'home' && /^\/(index\.html)?$/.test(window.location.pathname))
      prefetchAgentCount();
  }
}

/**
 * The chunk of a page Root can switch to without a reload (shell/pageNavigation.ts), or null.
 * The public pages need no session; the home page only once the session has answered (it then
 * shows the landing page or the console without a wait).
 */
function inAppPage(pathname: string, sessionKnown: boolean, signedIn: boolean) {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (path === '/downtown') return loadDowntown;
  if (path === '/workflows') return loadWorkflows;
  if (USE_CASE_PATH.test(path)) return loadUseCases;
  if (trustPage(path)) return loadTrust;
  if (
    /^\/docs(?:\/(start|rooms|room-management|coding|api|microsoft-copilot|mistral-le-chat))?$/.test(
      path,
    )
  )
    return loadDocs;
  if (path === '/downtown/verify') return loadVerify;
  if (path === '/downtown/log' || path === '/explorer') return loadLiveLog;
  if (path === '/explorer/base') return loadOnBase;
  if (PASSPORT_PATH.test(path)) return loadPassportPage;
  if (path === '/' && sessionKnown) return signedIn ? loadApp : loadLanding;
  // Signed out, /connect, /invite and /elric are public pages too: they change in place like the
  // others instead of reloading the whole page (a white flash). Signed in, they redirect, so a
  // full load stays the simple, safe path there.
  if (sessionKnown && !signedIn) {
    if (path === '/connect') return loadConnect;
    if (path === '/invite') return loadInvite;
    if (path === '/elric') return loadElricSignedOut;
  }
  return null;
}

/** How long the first session read may take before the page offers Retry. */
export const SESSION_DEADLINE_MS = 12_000;

/** Paths the SPA renders today: / plus the pages below and the room pages (shared/routes.ts). */
const KNOWN_PATHS = new Set([
  '/',
  '/index.html',
  '/about',
  '/workflows',
  '/connect',
  '/invite',
  '/signin',
  '/downtown',
  '/downtown/verify',
  '/downtown/log',
  '/explorer',
  '/explorer/base',
  '/docs',
  '/docs/start',
  '/docs/rooms',
  '/docs/room-management',
  '/docs/coding',
  '/docs/api',
  '/docs/microsoft-copilot',
  '/docs/mistral-le-chat',
  // The use-case pages (shared/use-cases.ts).
  USE_CASES_INDEX.path,
  ...USE_CASES.map((entry) => useCasePath(entry.slug)),
  // Account: the Google account link (docs/GOOGLE_SIGNIN.md).
  '/settings/account',
  // The Elric dashboard (behind CITY_ELRIC; ElricRoute below).
  '/elric',
]);

// The onboarding screen for accounts created with Google, loaded lazily like the account page.
const OnboardingPage = lazy(() =>
  import('./GoogleAccount').then((module) => ({ default: module.OnboardingPage })),
);

// "Meet Elric", shown once after a new account's onboarding, loaded lazily.
const MeetElric = lazy(() =>
  import('./elric/MeetElric').then((module) => ({ default: module.MeetElric })),
);

// The account page (Sign in with Google), loaded lazily: it is not part of the main bundle.
const AccountPage = lazy(() =>
  import('./GoogleAccount').then((module) => ({ default: module.AccountPage })),
);

/**
 * /elric: the dashboard only when Elric is on for this server (GET /api/elric answers 200).
 * Opening it from the workspace navigation keeps the workspace on screen: while the status and
 * the dashboard's chunk load (usually already prefetched, src/elric/prefetch.ts), Elric's own
 * frame shows in the page area (its skeleton), never the boot screen or a blank page. The chunk
 * is awaited here rather than through lazy(), so React never hides the workspace to suspend,
 * and the dashboard reuses the status instead of asking again.
 */
function ElricRoute({ embedded = false, personName }: { embedded?: boolean; personName?: string }) {
  const [ready, setReady] = useState<{
    status: ElricStatus | null;
    Dashboard: ElricDashboardModule['default'] | null;
  } | null>(readyElric);
  useEffect(() => {
    // Already drawn from the read-ahead (readyElric): nothing to wait for.
    if (ready) return;
    let active = true;
    const status = takeElricStatus().catch(() => null);
    const chunk = elricDashboardModule();
    void Promise.all([status, chunk]).then(
      ([value, loaded]) =>
        active && setReady({ status: value, Dashboard: loaded?.default ?? null }),
      (error: unknown) =>
        active &&
        // The chunk could not load: the error boundary offers a reload.
        setReady(() => {
          throw error;
        }),
    );
    return () => {
      active = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ready)
    return <ElricSkeleton embedded={embedded} initial={(personName ?? '').trim().charAt(0)} />;
  const { status, Dashboard } = ready;
  return status && Dashboard ? (
    <Dashboard embedded={embedded} status={status} personName={personName} />
  ) : (
    <NotFound />
  );
}
// Signed-out /elric (src/elric/ElricSignedOut.tsx), loaded lazily like the dashboard.
const ElricSignedOut = lazy(() =>
  loadElricSignedOut().then((module) => ({ default: module.ElricSignedOut })),
);

/**
 * /elric signed out: Elric's chat screen with a sign-in card, when Elric is on for this server
 * (GET /api/elric answers 401 for a visitor; 404 when Elric is off). Log in or Sign up opens the
 * sign-in page here, so a successful sign-in comes straight back to the chat.
 */
function ElricSignedOutRoute({ onSignedIn }: { onSignedIn: (operator: Operator) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [mode, setMode] = useState<'signin' | 'register' | null>(null);
  // The prerendered signed-out screen (src/prerender.tsx) stays on while Elric is checked.
  const [markup] = useState(prerendered);
  // Its controls do nothing until the live screen replaces it, so it stays marked busy.
  const loading = markup ? <PrerenderedMarkup markup={markup} busy /> : <Boot />;
  useEffect(() => {
    let active = true;
    api('/api/elric', undefined, 'GET')
      .then(() => active && setOn(true))
      // Only an explicit 404 means Elric is off. A visitor's 401 means it is on, and so does any
      // other failure (a crawler that may not fetch the API, a network error): showing the page
      // is better than telling crawlers and visitors that /elric does not exist.
      .catch((error) => active && setOn(!(error instanceof ApiError && error.status === 404)));
    return () => {
      active = false;
    };
  }, []);
  if (on === null) return loading;
  if (!on) return <NotFound />;
  if (mode)
    return (
      <Auth
        key={mode}
        initialRegister={mode === 'register'}
        claimPending={false}
        onSuccess={(operator) => onSignedIn(operator)}
      />
    );
  return (
    <Suspense fallback={loading}>
      <ElricSignedOut onAuth={setMode} />
    </Suspense>
  );
}

/**
 * Console views with their own address (shared/routes.ts): /settings, its sections, /agents and
 * /messages.
 * Signed in, they open that view of the console at "/"; signed out, sign-in comes first.
 * /settings/account is the account page itself (above); an unknown section stays a 404.
 */
const CONSOLE_PATHS: Readonly<Record<string, WorkspaceView>> = {
  '/agents': 'agents',
  '/messages': 'messages',
  '/settings': 'assistants',
  '/settings/connected-apps': 'assistants',
  '/settings/data': 'data',
  '/settings/activity': 'activity',
};

export function consolePathView(pathname: string): WorkspaceView | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return Object.hasOwn(CONSOLE_PATHS, path) ? CONSOLE_PATHS[path] : null;
}

export function knownPath(pathname: string) {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return KNOWN_PATHS.has(path) || isRoomsPath(path) || consolePathView(path) !== null;
}

/**
 * /signin?next=…: where to go after signing in. Room paths (see safeNext), or /invite, which
 * continues the first run into the person's room with its Invite sheet.
 */
function signInNext() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next === '/invite' ? INVITE_ROOMS_PATH : safeNext(next);
}

/**
 * Where a NEW account goes: the console Overview ("/"), unless the person came with a purpose:
 * an explicit room in `next` (/rooms/<id> or /r/<code>), `next=/invite` (the first-room flow),
 * or a pending join (/r/<code> opened before signing up). A #claim= link is handled by its
 * caller. Plain sign-ins keep signInNext() / Rooms.
 */
function registeredNext() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next === '/invite') return INVITE_ROOMS_PATH;
  if (next && next !== '/rooms' && safeNext(next) === next) return next;
  return pendingJoinPath() ?? '/';
}

/** Go to a post-sign-in destination; the invite path also asks for the first room. */
function continueTo(next: string) {
  if (next === INVITE_ROOMS_PATH) {
    // The person asked for their link ("Sign in to get your link"): the app may create their
    // first room without a second click (see RoomsShell).
    window.history.replaceState({ [CREATE_FIRST_ROOM_STATE]: true }, '', next);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } else navigate(next, true);
}

/** The Connect page's path; /#connect keeps working too. */
function isConnectPath(pathname: string) {
  return /^\/connect\/?$/.test(pathname);
}

type PublicRoute = 'home' | 'connect' | 'signin';
function routeFromHash(hash = window.location.hash): PublicRoute {
  if (hash === '#connect') return 'connect';
  if (hash === '#signin' || hash === '#create' || hash.startsWith('#claim=')) return 'signin';
  return 'home';
}

function Boot({ children }: { children?: ReactNode }) {
  return (
    <div className="boot-screen">
      <CityMark />
      <p className="boot-title">Central City</p>
      {children ?? (
        <p>
          <LoaderCircle className="spin" size={15} aria-hidden="true" />
          Opening Central City
        </p>
      )}
    </div>
  );
}

function Rendered({ children }: { children: ReactNode }) {
  useEffect(() => {
    releasePrerendered();
  }, []);
  return children;
}

/** While the page's chunk loads: its prerendered markup (src/shell/prerendered.ts), else Boot. */
function Loading() {
  const markup = prerendered();
  if (!markup) return <Boot />;
  return <PrerenderedMarkup markup={markup} />;
}

function PrerenderedMarkup({ markup, busy = false }: { markup: string; busy?: boolean }) {
  return (
    <div
      style={{ display: 'contents' }}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      data-prerendered=""
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Loading />}>
        <Rendered>{children}</Rendered>
      </Suspense>
    </ErrorBoundary>
  );
}

export function Root() {
  const workspaceV2 = useWorkspaceV2();
  const [initialEntry, setInitialEntry] = useState(true);
  const [session, setSession] = useState<{
    operator: Operator | null;
    setupRequired: boolean;
    /** Onboarding of an account created with Google (docs/GOOGLE_SIGNIN.md "Onboarding"). */
    onboarding?: OnboardingState;
  } | null>(null);
  const [sessionError, setSessionError] = useState('');
  // After a new account's onboarding: where to go once "Meet Elric" is done or skipped.
  const [meetElric, setMeetElric] = useState<(() => void) | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [route, setRoute] = useState<PublicRoute>(() => routeFromHash());
  // Path routing for /signin and the room pages; RoomsApp and navigate() announce via popstate.
  const [, setEntryRevision] = useState(0);
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    // Back and forward can cross a hash route too (e.g. /connect back to /), so both follow.
    const change = () => {
      const next = routeFromHash();
      // Sign-in reached through history (or a fragment link, which fires popstate before
      // hashchange): start the console chunk it leads to before the form renders.
      if (next === 'signin') void loadApp().catch(ignorePrefetchFailure);
      const apply = () => {
        setEntryRevision((value) => value + 1);
        setInitialEntry(false);
        setPath(window.location.pathname);
        setRoute(next);
      };
      // An in-app page change keeps the current page on screen until the next one is ready.
      if (takeInAppChange()) startTransition(apply);
      else apply();
    };
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  const signedIn = Boolean(session?.operator);
  // The Base statuses the agents' rows last read belong to the person signed in. Signing out, or
  // another person's session, starts without them: forgotten before anything of theirs renders.
  const statusesOf = useRef<string | null | undefined>(undefined);
  const personId = session?.operator?.id ?? null;
  if (statusesOf.current !== personId) {
    statusesOf.current = personId;
    forgetAllStatuses();
    setSignedInPerson(personId);
  }
  const landing = workspaceLanding({
    enabled: workspaceV2 && initialEntry,
    consoleEntry:
      workspaceView(window.history.state, selectedWorkspaceId() ?? session?.operator?.id ?? '') !==
      null,
    signedIn,
    onboarding: Boolean(session?.onboarding?.required || meetElric),
    pathname: path,
    search: window.location.search,
    hash: window.location.hash,
    pendingJoin: workspaceV2 ? pendingJoinPath() : null,
  });
  useEffect(() => {
    if (!session || session.onboarding?.required || meetElric) return;
    // Decide once after the initial session/onboarding. In-app visits to / deliberately
    // open the console, and consuming a legacy hash must not trigger another landing.
    setInitialEntry(false);
    if (landing) continueTo(landing);
  }, [session, meetElric, landing]);
  useEffect(() => setSignedIn(signedIn), [signedIn]);
  // For the next visit's first paint (src/shell/theme-boot.js): signed in shows no signed-out copy.
  useEffect(() => {
    if (session) rememberSignedIn(Boolean(session.operator));
  }, [session]);
  // The session could not be read: the Retry screen replaces any prerendered copy.
  useEffect(() => {
    if (sessionError) releasePrerendered();
  }, [sessionError]);
  // Links to pages Root can show change pages in place (shell/pageNavigation.ts).
  const sessionKnown = session !== null;
  useEffect(
    () => installInAppLinks((pathname) => inAppPage(pathname, sessionKnown, signedIn)),
    [sessionKnown, signedIn],
  );
  // The new page is on screen: its scroll position and focus, and the cross-fade may finish.
  useLayoutEffect(pageCommitted, [path, route]);
  // Signed in on /signin: go straight to where sign-in would have returned.
  useEffect(() => {
    if (signedIn && path === '/signin') navigate(signInNext(), true);
  }, [signedIn, path]);
  // Signed in on /settings, /settings/<section>, /agents or /messages: that console view, at "/" like every
  // console view (Back still leaves the console).
  const operatorId = session?.operator?.id;
  useEffect(() => {
    const view = consolePathView(path);
    if (!view || !operatorId) return;
    const workspaceId = (workspaceV2 ? selectedWorkspaceId() : null) ?? operatorId;
    window.history.replaceState(
      { workspaceView: view, workspaceId },
      '',
      `/${window.location.search}${window.location.hash}`,
    );
    setPath('/');
  }, [operatorId, path, workspaceV2]);
  // Signed in on /invite: "Invite your AI" is the person's room with its Invite sheet (§3.2, E1).
  useEffect(() => {
    if (signedIn && /^\/invite\/?$/.test(path)) navigate(INVITE_ROOMS_PATH, true);
  }, [signedIn, path]);
  // Signed in on /connect: the console's "Connect your AI" view, which it opens from #connect.
  useEffect(() => {
    if (signedIn && isConnectPath(path)) navigate('/#connect', true);
  }, [signedIn, path]);
  // Whatever way the page arrives at sign-in, the console chunk it leads to is on its way.
  useEffect(() => {
    if (route === 'signin') void loadApp().catch(ignorePrefetchFailure);
  }, [route]);
  // Signed out on /#connect: the Connect page's own address is /connect (the entry is replaced,
  // so Back still returns to the page before).
  useEffect(() => {
    if (session && !session.operator && path === '/' && route === 'connect') {
      window.history.replaceState(window.history.state, '', '/connect');
      setPath('/connect');
    }
  }, [session, path, route]);
  const publicPath = /^\/downtown\/?$/.test(path);
  const trust = trustPage(path);
  const known = knownPath(path);
  // The session is read on public pages too (not awaited there), so a signed-in visitor's
  // "Invite your AI" goes to their room.
  useEffect(() => {
    if (!known) return;
    let active = true;
    // A stalled session read (cold start, mid-deploy) ends in the Retry state, not an endless
    // "Opening Central City".
    const controller = new AbortController();
    let timedOut = false;
    let retry = 0;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SESSION_DEADLINE_MS);
    void api<{ operator: Operator | null; setupRequired: boolean; onboarding?: OnboardingState }>(
      '/api/session',
      undefined,
      'GET',
      controller.signal,
    )
      .then((value) => {
        if (active) {
          // Signed in: the app replaces the signed-out copy, which must not show while its
          // chunk loads (src/shell/prerendered.ts).
          if (value.operator) releasePrerendered();
          setSession(value);
          setSessionError('');
        }
      })
      .catch((error) => {
        if (!active) return;
        // A signed-out page that arrived prerendered (/, /connect, …) keeps that copy and
        // retries quietly: an error screen there hides the page from visitors and crawlers.
        if (prerendered()) {
          const wait = Math.min(30_000, 2_000 * 2 ** Math.min(sessionAttempt, 4));
          retry = window.setTimeout(() => setSessionAttempt((value) => value + 1), wait);
          return;
        }
        setSessionError(
          timedOut
            ? 'Central City is taking too long to answer.'
            : error instanceof Error
              ? error.message
              : "We couldn't reach Central City.",
        );
      })
      .finally(() => window.clearTimeout(deadline));
    return () => {
      active = false;
      window.clearTimeout(deadline);
      window.clearTimeout(retry);
      controller.abort();
    };
  }, [sessionAttempt, known]);
  useEffect(() => {
    const change = () => {
      const next = routeFromHash();
      setRoute(next);
      // Moving to sign-in in-page: fetch the console it leads to in the background.
      if (next === 'signin') void loadApp().catch(ignorePrefetchFailure);
      const target = window.location.hash.slice(1);
      const element = /^[a-z-]+$/.test(target) ? document.getElementById(target) : null;
      if (next === 'home' && element) {
        element.scrollIntoView();
        element.focus({ preventScroll: true });
      } else window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  // Public open-source page: same for signed-out and signed-in visitors, no session needed.
  if (publicPath)
    return (
      <Screen>
        <Downtown />
      </Screen>
    );
  // The newsletter email links (confirm, unsubscribe): public, no session needed.
  const newsletterLink = /^\/newsletter\/(confirm|unsubscribe)\/?$/.exec(path);
  if (newsletterLink)
    return (
      <Screen>
        <NewsletterLinkPage action={newsletterLink[1] as 'confirm' | 'unsubscribe'} />
      </Screen>
    );
  // Trust pages: public, the same for every visitor, no session needed.
  if (trust)
    return (
      <Screen>
        <TrustPage page={trust} />
      </Screen>
    );
  if (/^\/workflows\/?$/.test(path))
    return (
      <Screen>
        <WorkflowsPage />
      </Screen>
    );
  const useCase = USE_CASE_PATH.exec(path);
  if (useCase)
    return <Screen>{useCase[1] ? <UseCasePage slug={useCase[1]} /> : <UseCasesIndex />}</Screen>;
  // "Verify here": the public, in-browser verification of the agent count (no session needed;
  // the page asks for one only to check the visitor's own agent).
  const docs =
    /^\/docs(?:\/(start|rooms|room-management|coding|api|microsoft-copilot|mistral-le-chat))?\/?$/.exec(
      path,
    );
  if (docs)
    return (
      <Screen>
        <DocsPage page={(docs[1] ?? 'index') as DocsPageId} />
      </Screen>
    );
  if (/^\/downtown\/verify\/?$/.test(path))
    return (
      <Screen>
        <VerifyPage />
      </Screen>
    );
  // The Agent Explorer's On Base view (its own address, to share).
  if (/^\/explorer\/base\/?$/.test(path))
    return (
      <Screen>
        <OnBase />
      </Screen>
    );
  // The Agent Explorer: /explorer (its short address) and /downtown/log show the same page.
  if (/^\/(downtown\/log|explorer)\/?$/.test(path))
    return (
      <Screen>
        <LiveLog />
      </Screen>
    );
  // A Base agent's passport: /a/<short id> (public, no session needed).
  const passport = PASSPORT_PATH.exec(path);
  if (passport)
    return (
      <Screen>
        <Passport key={passport[1]} id={passport[1]!} />
      </Screen>
    );
  // Hash routing still decides the view; any other path is a 404.
  if (!known) return <NotFound />;
  if (!session)
    return sessionError ? (
      <Boot>
        <p role="alert">{sessionError}</p>
        <button
          className="button primary"
          onClick={() => {
            setSessionError('');
            setSessionAttempt((value) => value + 1);
          }}
        >
          Try again
        </button>
      </Boot>
    ) : (
      // A session-gated page's prerendered signed-out copy stays on until the session answers.
      <Loading />
    );
  // Onboarding gate: an account created with Google sees only the onboarding screen, on every
  // route (Back included), until it has a name and has accepted the Terms. The server refuses
  // every other API call (403 onboarding_required) as well.
  if (session.operator && session.onboarding?.required)
    return (
      <Screen>
        <OnboardingPage
          state={session.onboarding}
          onDone={(operator) => {
            const newAccount = session.onboarding?.name_needed === true;
            setSession({ ...session, operator, onboarding: undefined });
            const proceed = () => {
              const next = safeReturnPath(new URLSearchParams(window.location.search).get('next'));
              const here = window.location.pathname;
              if (next && next !== here) window.location.assign(next);
              else if (/^\/settings\/account\/?$/.test(here) || here === '/signin')
                window.location.assign('/rooms');
            };
            // A brand-new account meets Elric once; a Terms re-acceptance, or a sign-up that
            // started on /elric (it goes there next), goes straight on.
            const toElric =
              safeReturnPath(new URLSearchParams(window.location.search).get('next')) === '/elric';
            if (newAccount && !toElric) setMeetElric(() => proceed);
            else proceed();
          }}
        />
      </Screen>
    );
  if (session.operator && meetElric)
    return (
      <Screen>
        <MeetElric
          onContinue={() => {
            setMeetElric(null);
            meetElric();
          }}
        />
      </Screen>
    );
  function workspace(content?: ReactNode, title?: string) {
    if (!session?.operator) return null;
    return (
      <Workspaces
        person={session.operator}
        pageTitle={title}
        onLogout={() => {
          setRoute('signin');
          window.history.replaceState(null, '', '/#signin');
          setPath('/');
          setSession({ operator: null, setupRequired: false });
        }}
      >
        {content}
      </Workspaces>
    );
  }
  // Account (the Google account link) and the Elric dashboard: signed out, sign in first.
  const elric = /^\/elric\/?$/.test(path);
  if (elric || /^\/settings\/account\/?$/.test(path))
    return (
      <Screen>
        {session.operator ? (
          workspaceV2 ? (
            workspace(
              elric ? <ElricRoute embedded personName={session.operator.name} /> : <AccountPage />,
              elric ? 'Elric' : 'Settings',
            )
          ) : elric ? (
            <ElricRoute />
          ) : (
            <AccountPage />
          )
        ) : elric ? (
          <ElricSignedOutRoute
            onSignedIn={(operator) => setSession({ operator, setupRequired: false })}
          />
        ) : (
          <Auth
            initialRegister={false}
            claimPending={false}
            onSuccess={(operator) => {
              setSession({ operator, setupRequired: false });
            }}
          />
        )}
      </Screen>
    );
  if (consolePathView(path))
    return session.operator ? (
      // The effect above opens the console view.
      <Boot />
    ) : (
      <Screen>
        <Auth
          initialRegister={false}
          claimPending={false}
          onSuccess={(operator) => setSession({ operator, setupRequired: false })}
        />
      </Screen>
    );
  if (!session.operator) {
    // Room pages handle signed-out visitors themselves (join screen, "Sign in to join").
    if (isRoomsPath(path))
      return (
        <Screen>
          <RoomsShell signedIn={false} workspaceId="" accountName="" />
        </Screen>
      );
    if (path === '/invite' || path === '/invite/')
      return (
        <Screen>
          <InvitePage />
        </Screen>
      );
    if (path === '/signin')
      return (
        <Screen>
          <Auth
            initialRegister={session.setupRequired}
            claimPending={false}
            onSuccess={(operator, { registered }) => {
              continueTo(registered ? registeredNext() : signInNext());
              setSession({ operator, setupRequired: false });
            }}
          />
        </Screen>
      );
    if (route === 'connect' || (route === 'home' && isConnectPath(path)))
      return (
        <Screen>
          <ConnectPage />
        </Screen>
      );
    if (route === 'signin')
      return (
        <Screen>
          {/* Not lazy: see src/Auth.tsx. The console chunk is fetched in the background. */}
          <Auth
            key={window.location.hash === '#create' ? 'create' : 'signin'}
            initialRegister={session.setupRequired || window.location.hash === '#create'}
            claimPending={window.location.hash.startsWith('#claim=')}
            onSuccess={(operator, { registered }) => {
              // Claiming agents continues in the console. A new account starts on the Overview
              // (or where it came to go); a plain sign-in lands on Rooms.
              if (!window.location.hash.startsWith('#claim='))
                continueTo(registered ? registeredNext() : '/rooms');
              setSession({ operator, setupRequired: false });
            }}
          />
        </Screen>
      );
    return (
      <Screen>
        <Landing setupRequired={session.setupRequired} />
      </Screen>
    );
  }
  if (landing) return <Boot />;
  if (path === '/invite' || path === '/invite/' || isConnectPath(path)) {
    // Signed in: the effect above moves on to the person's room with its Invite sheet.
    return <Boot />;
  }
  if (isRoomsPath(path)) {
    // The workspace chosen in the console (api.ts keeps it; requests carry X-City-Workspace).
    const workspaceId = selectedWorkspaceId() ?? session.operator.id;
    return (
      <Screen>
        {workspaceV2 ? (
          workspace(
            <RoomsShell
              signedIn
              embedded
              workspaceId={workspaceId}
              accountName={session.operator.name}
            />,
            'Rooms',
          )
        ) : (
          <RoomsShell signedIn workspaceId={workspaceId} accountName={session.operator.name} />
        )}
      </Screen>
    );
  }
  return <Screen>{workspace()}</Screen>;
}
