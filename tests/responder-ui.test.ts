import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent } from '../shared/types.js';
import { AutoReplySheet } from '../src/responder/AutoReply.js';
import {
  LIMITS,
  PAUSE_REASONS,
  type ModelOption,
  type ResponderSettingsView,
} from '../src/responder/contract.js';
import {
  consentNotice,
  costPerReply,
  parseUsd,
  pauseCopy,
  setupErrorCopy,
} from '../src/responder/copy.js';

// The allowlist as #93 serves it (server/responder/models.ts, checked 28 Sep).
const MODELS: ModelOption[] = [
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5 (retiring)',
    est_cost_per_reply_usd: 0.01,
    default: false,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    est_cost_per_reply_usd: 0.02,
    default: true,
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    est_cost_per_reply_usd: 0.04,
    default: false,
  },
  {
    provider: 'openai',
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    est_cost_per_reply_usd: 0.01,
    default: false,
  },
  {
    provider: 'openai',
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    est_cost_per_reply_usd: 0.02,
    default: true,
  },
];
const AGENT = { id: '11111111-1111-4111-8111-111111111111', name: 'Hazel' } as Agent;
const sheet = (mode: 'setup' | 'key' | 'settings', settings: ResponderSettingsView | null = null) =>
  renderToStaticMarkup(
    createElement(AutoReplySheet, {
      mode,
      agent: AGENT,
      models: MODELS,
      settings,
      onClose: () => undefined,
      onSaved: () => undefined,
    }),
  );

test('the contract mirrors #93: limits, defaults and pause reasons', () => {
  assert.deepEqual(LIMITS.replyCap, { min: 1, max: 1000, default: 100 });
  assert.deepEqual(LIMITS.spendCapUsd, { min: 0.01, max: 50, default: 2 });
  assert.equal(LIMITS.instructionsMax, 2000);
  assert.deepEqual([...PAUSE_REASONS].sort(), [
    'forbidden',
    'invalid_key',
    'key_removed',
    'model_unavailable',
    'quota',
    'rate_limited',
    'repeated_failures',
  ]);
});

test('setup sheet: Anthropic with Sonnet 5 by default, Haiku marked retiring, write-only key field', () => {
  const out = sheet('setup');
  assert.match(out, /<input type="radio"[^>]*checked=""[^>]*value="anthropic"/);
  assert.match(
    out,
    /<option value="claude-sonnet-5" selected="">Claude Sonnet 5 · about \$0\.02 a reply<\/option>/,
  );
  assert.match(out, /Claude Haiku 4\.5 \(retiring\)/);
  assert.doesNotMatch(out, /GPT-6/, 'only the chosen provider’s models');
  // The key: a password field, never autocompleted or spell-checked, empty.
  const key = /<input[^>]*class="ar-key"[^>]*>/.exec(out)![0];
  for (const attr of [
    'type="password"',
    'autoComplete="new-password"',
    'data-1p-ignore="true"',
    'data-lpignore="true"',
    'data-bwignore="true"',
    'spellCheck="false"',
    'value=""',
  ])
    assert.ok(key.includes(attr), `${attr} in ${key}`);
  assert.match(out, /The key is never shown again\./);
  // Limits default to 100 replies and $2.00; instructions are optional (closed).
  assert.match(out, /type="number"[^>]*value="100"/);
  assert.match(out, /inputMode="decimal"[^>]*value="2\.00"/);
  // The consent: a plain notice naming the provider, and "Turn on" as the only primary.
  assert.ok(out.includes(consentNotice('Hazel', 'anthropic').replaceAll("'", '&#x27;')));
  assert.match(out, /Anthropic bills you\./);
  assert.match(out, /<button type="submit" class="button primary">Turn on<\/button>/);
  assert.doesNotMatch(out, /type="checkbox"/, 'the button is the consent, not a checkbox');
});

test('replace-key and settings sheets show only what they change', () => {
  const settings: ResponderSettingsView = {
    agent_id: AGENT.id,
    enabled: true,
    status: 'active',
    pause_reason: null,
    paused_until: null,
    provider: 'openai',
    model: 'gpt-6-luna',
    instructions: 'Answer briefly.',
    daily_reply_cap: 250,
    daily_spend_cap_usd: 1.5,
    key: {
      provider: 'openai',
      added_at: '2026-09-27T10:00:00.000Z',
      validated_at: '2026-09-27T10:00:00.000Z',
      status: 'active',
    },
    replies_available: false,
  };
  const key = sheet('key', settings);
  assert.match(key, /class="ar-key"/);
  assert.match(key, /checked=""[^>]*value="openai"/);
  assert.match(key, /<option value="gpt-6-luna" selected="">/);
  assert.doesNotMatch(key, /Limits|Instructions|bills you/);
  assert.match(key, />Save key</);
  const edit = sheet('settings', settings);
  assert.doesNotMatch(edit, /class="ar-key"|type="radio"/);
  assert.match(edit, /value="250"/);
  assert.match(edit, /value="1\.50"/);
  assert.match(edit, />Answer briefly\.</);
  assert.match(edit, />Save</);
});

test('every pause reason reads as plain words with the action that resolves it', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const expected: Record<string, [RegExp, string | null]> = {
    invalid_key: [/^Paused: OpenAI rejected the key\.$/, 'change_key'],
    forbidden: [/^Paused: OpenAI doesn't allow this key/, 'change_key'],
    key_removed: [/^Off: the key was removed\.$/, 'change_key'],
    quota: [/^Paused: your OpenAI quota is used up\.$/, 'resume'],
    model_unavailable: [/can't use the chosen model/, 'pick_model'],
    rate_limited: [/^Paused for 15 min: OpenAI rate limit\. It resumes by itself\.$/, null],
    repeated_failures: [/^Paused after repeated errors from OpenAI\.$/, 'resume'],
  };
  for (const reason of PAUSE_REASONS) {
    const copy = pauseCopy(reason, 'openai', '2026-09-28T10:15:00Z', now);
    assert.match(copy.text, expected[reason]![0], reason);
    assert.equal(copy.action, expected[reason]![1], reason);
    assert.doesNotMatch(copy.text, /_/, `${reason}: no raw code in the copy`);
  }
});

test('server codes map to plain copy on the right field; server text is never used', () => {
  const ctx = { provider: 'openai' as const, model: 'GPT-6 Sol' };
  assert.deepEqual(setupErrorCopy('invalid_key', ctx), {
    message: "OpenAI didn't accept this key. Check that you copied all of it.",
    field: 'key',
  });
  assert.equal(
    setupErrorCopy('unsupported_key', ctx).message,
    'Use a standard API key, not an admin key.',
  );
  assert.equal(setupErrorCopy('model_unavailable', ctx).field, 'model');
  assert.match(setupErrorCopy('model_unavailable', ctx).message, /can't use GPT-6 Sol/);
  assert.equal(setupErrorCopy('provider_unreachable', ctx).retry, true);
  assert.equal(setupErrorCopy('timeout', ctx).retry, true);
  assert.match(
    setupErrorCopy('invalid_key_format', { provider: 'anthropic' }).message,
    /sk-ant-api/,
  );
  assert.match(
    setupErrorCopy('', { provider: 'openai', status: 429 }).message,
    /Too many attempts/,
  );
  assert.match(setupErrorCopy('something_new', ctx).message, /Something went wrong/);
});

test('money: costs and typed caps', () => {
  assert.equal(costPerReply(0.02), 'about $0.02 a reply');
  assert.equal(parseUsd('$2'), 2);
  assert.equal(parseUsd('0.01'), 0.01);
  assert.equal(parseUsd('50.00'), 50);
  for (const bad of ['', 'abc', '1.234', '-1', '1,5', '1e3'])
    assert.equal(parseUsd(bad), null, bad);
});

test('the key never reaches storage, logs or the URL', () => {
  const dir = join(import.meta.dirname, '..', 'src', 'responder');
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|indexedDB|console\.(log|info|warn|error|debug)|document\.cookie/,
      file,
    );
    assert.doesNotMatch(source, /[?&]key=/, file);
  }
});
