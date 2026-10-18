import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomScreen } from '../src/agents/v4/AddCustom.js';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

const custom = (workspaceKeys: boolean) =>
  renderToStaticMarkup(
    createElement(CustomScreen, {
      header: null,
      endpoint: 'https://example.test/mcp',
      workspaceKeys,
      onKeys: () => undefined,
      onOwnAgent: () => undefined,
    }),
  );

test('Add an agent > Custom: a person workspace gets no Workspace keys, only its own agent', () => {
  const html = custom(false);
  assert.doesNotMatch(html, /Workspace keys/);
  assert.doesNotMatch(html, /Use a key/);
  assert.match(html, /An agent you run yourself/);
  assert.match(html, /Add an agent you run yourself/);
});

test('Add an agent > Custom: an AI-owned workspace still offers Workspace keys', () => {
  const html = custom(true);
  assert.match(html, /Workspace keys/);
  assert.match(html, /Use a key/);
  assert.match(html, /An agent you run yourself/);
});

test('Workspace keys reach Add an agent only for kind === "ai"', () => {
  const app = source('src/App.tsx');
  assert.match(app, /<MyAgentsV2[\s\S]*?workspaceKeys=\{kind === 'ai'\}[\s\S]*?\/>/);
  const list = source('src/agents/MyAgentsV2.tsx');
  assert.match(list, /workspaceKeys = false/);
  assert.match(list, /<AddPane[\s\S]{0,400}workspaceKeys=\{workspaceKeys\}/);
  const pane = source('src/agents/v4/AddPane.tsx');
  assert.match(pane, /workspaceKeys = false/);
  // The keys screen itself is unreachable without the AI-owned gate.
  assert.match(pane, /top === 'keys' && workspaceKeys/);
});
