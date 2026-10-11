import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_APPS,
  aiAppSteps,
  connectEndpoint,
  joinedAi,
  nextAiApp,
  showWhoJoins,
} from '../src/rooms/aiApps.js';
import {
  claudeCodeCommand,
  claudeConnectLink,
  codexAddCommand,
  codexLoginCommand,
  cursorDeeplink,
  geminiAddCommand,
  geminiAuthCommand,
  geminiExtensionCommand,
} from '../src/shell/connectLinks.js';

// "Who should join?" and Add an AI (docs/design/ROOM_WHO_JOINS.md §2, §3).
const ENDPOINT = 'https://centralcity.ai/mcp';

test('the seven apps, in the grid order of the design', () => {
  assert.deepEqual(
    AI_APPS.map((app) => app.name),
    ['Claude', 'ChatGPT', 'Gemini CLI', 'Claude Code', 'Codex', 'Cursor', 'Other'],
  );
});

test('every app has the same four parts; Open for deep links, Copy for addresses and commands', () => {
  const action = Object.fromEntries(
    AI_APPS.map((app) => [app.id, aiAppSteps(app.id, ENDPOINT).row.action]),
  );
  assert.deepEqual(action, {
    claude: 'open',
    chatgpt: 'copy',
    'gemini-cli': 'copy',
    'claude-code': 'copy',
    codex: 'copy',
    cursor: 'open',
    other: 'copy',
  });
  for (const app of AI_APPS) {
    const steps = aiAppSteps(app.id, ENDPOINT);
    assert.ok(steps.lead && steps.note && steps.row.text, app.id);
    assert.equal(
      steps.then,
      `Then paste the room invite into ${app.id === 'other' ? 'your AI' : app.name}.`,
    );
    // Short lines, so the fixed-height steps block never overflows.
    assert.ok(steps.lead.length <= 52, `${app.id}: ${steps.lead}`);
    assert.ok(steps.note.length <= 52, `${app.id}: ${steps.note}`);
  }
});

test("the addresses, commands and links are the Connect page's (one source)", () => {
  const row = (id: Parameters<typeof aiAppSteps>[0]) => aiAppSteps(id, ENDPOINT).row;
  assert.deepEqual(row('claude'), {
    action: 'open',
    text: 'Claude · Central City connector',
    href: claudeConnectLink(ENDPOINT),
  });
  assert.deepEqual(row('cursor'), {
    action: 'open',
    text: 'Cursor · Central City connector',
    href: cursorDeeplink(ENDPOINT),
  });
  const copied = (id: Parameters<typeof aiAppSteps>[0]) => {
    const value = row(id);
    assert.equal(value.action, 'copy');
    return value.action === 'copy' ? value.value : '';
  };
  assert.equal(copied('chatgpt'), ENDPOINT);
  assert.equal(copied('other'), ENDPOINT);
  assert.equal(copied('claude-code'), claudeCodeCommand(ENDPOINT));
  assert.equal(
    copied('claude-code'),
    'claude mcp add --transport http central-city https://centralcity.ai/mcp',
  );
  assert.equal(copied('codex'), 'codex mcp add central-city --url https://centralcity.ai/mcp');
  assert.equal(copied('codex'), codexAddCommand(ENDPOINT));
  assert.equal(aiAppSteps('codex', ENDPOINT).note, `Then run: ${codexLoginCommand()}`);
  assert.equal(codexLoginCommand(), 'codex mcp login central-city');
});

test('the sheet offers Gemini CLI with the published extension install line', () => {
  const app = AI_APPS.find((item) => item.id === 'gemini-cli');
  assert.equal(app?.name, 'Gemini CLI');
  // Right after ChatGPT, so it is prominent.
  assert.equal(AI_APPS.indexOf(app!), AI_APPS.findIndex((item) => item.id === 'chatgpt') + 1);
  const steps = aiAppSteps('gemini-cli', ENDPOINT);
  assert.deepEqual(steps.row, {
    action: 'copy',
    text: 'gemini extensions install https://github.com/centralcity-ai-hq/gemini-cli-extension',
    value: geminiExtensionCommand(),
    describedAs: 'Gemini CLI extension command',
  });
  // /mcp auth is typed inside Gemini CLI, not in the terminal.
  assert.equal(steps.note, `Then open Gemini CLI and run: ${geminiAuthCommand()}`);
  assert.equal(geminiAuthCommand(), '/mcp auth central-city');
  // A local server: the extension installs from the live site, so the sheet adds by hand.
  const local = 'http://127.0.0.1:4311/mcp';
  const localRow = aiAppSteps('gemini-cli', local, true).row;
  assert.ok(localRow.action === 'copy' && localRow.value === geminiAddCommand(local));
  assert.equal(geminiAddCommand(local), `gemini mcp add --transport http central-city ${local}`);
});

test('a local server: chat apps open the live site; coding apps use the local address', () => {
  const local = 'http://127.0.0.1:4311/mcp';
  for (const id of ['claude', 'chatgpt'] as const) {
    const steps = aiAppSteps(id, local, true);
    assert.equal(steps.row.action, 'open');
    assert.ok(steps.row.action === 'open' && steps.row.href === 'https://centralcity.ai');
    assert.match(steps.lead, /needs a public address/);
  }
  const code = aiAppSteps('claude-code', local, true).row;
  assert.ok(code.action === 'copy' && code.value.endsWith(local));
  assert.equal(connectEndpoint('http://127.0.0.1:4311', '127.0.0.1'), local);
  assert.equal(connectEndpoint('https://preview.example', 'preview.example'), ENDPOINT);
});

test('arrow keys move through the apps and wrap; other keys do nothing', () => {
  assert.equal(nextAiApp('claude', 'ArrowRight'), 'chatgpt');
  assert.equal(nextAiApp('claude', 'ArrowDown'), 'chatgpt');
  assert.equal(nextAiApp('chatgpt', 'ArrowRight'), 'gemini-cli');
  assert.equal(nextAiApp('claude-code', 'ArrowLeft'), 'gemini-cli');
  assert.equal(nextAiApp('other', 'ArrowRight'), 'claude');
  assert.equal(nextAiApp('claude', 'ArrowLeft'), 'other');
  assert.equal(nextAiApp('codex', 'ArrowUp'), 'claude-code');
  assert.equal(nextAiApp('codex', 'Home'), 'claude');
  assert.equal(nextAiApp('codex', 'End'), 'other');
  assert.equal(nextAiApp('codex', 'Enter'), null);
});

test('the sheet closes for a new AI only, not for a person or someone already there', () => {
  const baseline = new Set(['host']);
  assert.equal(joinedAi(baseline, [{ id: 'host' }]), undefined);
  assert.equal(joinedAi(baseline, [{ id: 'host' }, { id: 'p', kind: 'person' }]), undefined);
  assert.deepEqual(joinedAi(baseline, [{ id: 'host' }, { id: 'a', kind: 'agent' }]), {
    id: 'a',
    kind: 'agent',
  });
  assert.deepEqual(joinedAi(baseline, [{ id: 'host' }, { id: 'b' }]), { id: 'b' });
});

test('the card: the host of an open room, while alone, until hidden', () => {
  const base = {
    host: true,
    closed: false,
    denied: false,
    hidden: false,
    membersLoaded: true,
    members: [{ role: 'host' }],
  };
  assert.equal(showWhoJoins(base), true);
  assert.equal(showWhoJoins({ ...base, host: false }), false);
  assert.equal(showWhoJoins({ ...base, closed: true }), false);
  assert.equal(showWhoJoins({ ...base, denied: true }), false);
  assert.equal(showWhoJoins({ ...base, hidden: true }), false);
  // Never flashes before the member list has loaded.
  assert.equal(showWhoJoins({ ...base, membersLoaded: false }), false);
  // Gone once anyone else is in the room.
  assert.equal(showWhoJoins({ ...base, members: [{ role: 'host' }, { role: 'member' }] }), false);
  // You in your own room as a person (Agency A1) are not anyone else; another person is.
  const me = { role: 'member', own: true, kind: 'person' };
  assert.equal(showWhoJoins({ ...base, members: [{ role: 'host' }, me] }), true);
  assert.equal(
    showWhoJoins({ ...base, members: [{ role: 'host' }, me, { role: 'member', kind: 'person' }] }),
    false,
  );
  assert.equal(
    showWhoJoins({
      ...base,
      members: [{ role: 'host' }, { role: 'member', own: true, kind: 'agent' }],
    }),
    false,
  );
});

test('the card renders the two tiles as buttons, with no template wording', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { WhoJoinsCard } = await import('../src/rooms/WhoJoins.js');
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(WhoJoinsCard, { onAi: noop, onPerson: noop, onHide: noop }),
  );
  assert.match(html, /<h2[^>]*>Who should join\?<\/h2>/);
  assert.match(html, /Nobody joins until you invite them\./);
  assert.match(html, /aria-label="Hide Who should join\?"/);
  assert.equal(html.match(/class="rm-who-tile"/g)?.length, 2);
  assert.match(html, /<strong>An AI<\/strong><span>Builds, reviews or helps<\/span>/);
  assert.match(html, /<strong>A person<\/strong><span>Decides and approves<\/span>/);
  assert.doesNotMatch(html, /template|Suggested/i);
});
