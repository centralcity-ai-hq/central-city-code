import React from 'react';
import ReactDOM from 'react-dom/client';
import './shell/tokens.css';
import './shell/motion.css';
import { prefetchInitialScreen, Root } from './Root';
import { applyStoredTheme } from './brand';
import { capturePendingJoin } from './rooms/pendingJoin';
import { captureManageCode } from './feed/feedPaths';
import { capturePrerendered } from './shell/prerendered';
import { captureBuildAgentCount, captureBuildPaidCallsLine } from './agentCount';
import { installChunkReload } from './shell/chunkReload';
import { installWebAnalytics } from './shell/webAnalytics';
import './styles.css';

// A chunk the last deploy removed reloads the page (src/shell/chunkReload.ts): installed before
// the first dynamic import below.
installChunkReload();
// A join code (/r/<slug>#<code>) leaves the address bar before anything renders (ROOMS_UX.md).
capturePendingJoin();
// So does a Feed request's private code (/feed/requests/<id>/manage#ccf_…), kept in memory.
captureManageCode();
applyStoredTheme();
// iOS Safari applies :active (the press states in shell/motion.css) only once a page listens
// for touches.
document.addEventListener('touchstart', () => undefined, { passive: true });
prefetchInitialScreen();
// Cookieless page views on centralcity.ai only, ids and codes removed (src/shell/webAnalytics.ts).
installWebAnalytics();

const root = document.getElementById('root')!;
capturePrerendered(root);
// The agent count the build put into the landing HTML (scripts/prerender/agent-count.ts), when
// that markup is still on screen (capturePrerendered drops a session-gated copy).
captureBuildAgentCount(root);
// The paid service calls line the build reserved (never a number), likewise.
captureBuildPaidCallsLine(root);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
