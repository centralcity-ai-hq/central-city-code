import React from 'react';
import ReactDOM from 'react-dom/client';
import './shell/tokens.css';
import './shell/motion.css';
import { prefetchInitialScreen, Root } from './Root';
import { applyStoredTheme } from './brand';
import { capturePendingJoin } from './rooms/pendingJoin';
import { capturePrerendered } from './shell/prerendered';
import { captureBuildAgentCount } from './agentCount';
import { installChunkReload } from './shell/chunkReload';
import './styles.css';

// A chunk the last deploy removed reloads the page (src/shell/chunkReload.ts): installed before
// the first dynamic import below.
installChunkReload();
// A join code (/r/<slug>#<code>) leaves the address bar before anything renders (ROOMS_UX.md).
capturePendingJoin();
applyStoredTheme();
// iOS Safari applies :active (the press states in shell/motion.css) only once a page listens
// for touches.
document.addEventListener('touchstart', () => undefined, { passive: true });
prefetchInitialScreen();

const root = document.getElementById('root')!;
capturePrerendered(root);
// The agent count the build put into the landing HTML (scripts/prerender/agent-count.ts), when
// that markup is still on screen (capturePrerendered drops a session-gated copy).
captureBuildAgentCount(root);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
