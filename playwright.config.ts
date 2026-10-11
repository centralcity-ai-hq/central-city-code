import { defineConfig } from '@playwright/test';
import { resolveE2EPort } from './e2e/port';

// One port per run: E2E_PORT, else 4311 when free, else a free port (e2e/port.ts).
const port = await resolveE2EPort();
const origin = `http://127.0.0.1:${port}`;
// Sign in with Google runs on its own server with a fake Google (e2e/google-server.ts) and a
// fake consent page; both ports follow from the main one, so the workers compute the same.
process.env.E2E_GOOGLE_PORT ??= String(port + 2);
process.env.E2E_GOOGLE_FAKE_PORT ??= String(port + 3);
const googlePort = Number(process.env.E2E_GOOGLE_PORT);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  // A first render on a busy CI machine can take more than the default 5 s.
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: origin,
    channel:
      process.env.CITY_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: [
    {
      command: 'node --import tsx server/index.ts',
      url: `${origin}/api/session`,
      reuseExistingServer: false,
      timeout: 60_000,
      // Each spec registers its own isolated workspace; production keeps the default of 10.
      env: {
        PORT: String(port),
        CITY_DATA_DIR: 'memory://',
        CITY_LIMIT_REGISTRATIONS_PER_WINDOW: '1000',
        // The whole suite registers more accounts than one installation's default cap of 50.
        CITY_LIMIT_OPERATORS: '1000',
        // Every spec shares 127.0.0.1, so the whole suite would share one address's API budget
        // (600 a minute in deployments); the test server raises it for the suite only.
        CITY_LIMIT_API_REQUESTS_PER_MINUTE: '100000',
        // Several specs create real AI workspaces from 127.0.0.1 (production allows 3 an hour).
        CITY_LIMIT_AI_WORKSPACE_CREATES_PER_SOURCE_PER_HOUR: '10',
        // Room tasks (docs/ROOM_TASKS.md) are on in production; the Tasks panel needs its routes.
        CITY_ROOM_TASKS: '1',
        // The count-log cron endpoint (e2e/verify.spec.ts takes a checkpoint through it).
        CRON_SECRET: 'e2e-count-log-cron-secret',
        // Pin the cron gate to a Berlin-noon instant (12:00 CEST) so the suite passes at any
        // time of day; the checkpoint itself is still dated by the app clock.
        CITY_COUNT_LOG_CRON_NOW: '2026-10-01T10:00:00Z',
      },
    },
    {
      command: 'node --import tsx e2e/google-server.ts',
      url: `http://127.0.0.1:${googlePort}/api/auth/google`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(googlePort),
        E2E_GOOGLE_FAKE_PORT: process.env.E2E_GOOGLE_FAKE_PORT,
        // Elric on the mock model, for end-to-end specs that need a verified Google identity.
        CITY_ELRIC: '1',
        CITY_ELRIC_MOCK: '1',
        // The room header with Members, Elric and Tasks together (e2e/elric-controls.spec.ts).
        CITY_ROOM_TASKS: '1',
        CITY_LIMIT_REGISTRATIONS_PER_WINDOW: '1000',
        CITY_LIMIT_API_REQUESTS_PER_MINUTE: '100000',
      },
    },
  ],
});
