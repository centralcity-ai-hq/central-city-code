import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantAgentSchema } from '../server/assistant-access.js';

/*
 * The agent create and rename schema (POST /api/agents, the rename, the MCP create path). The
 * workspace is saved as jsonb, which refuses U+0000: such text answers 400, never a 500.
 */

const base = { capability: 'extract', mode: 'external' } as const;
const ok = (input: Record<string, unknown>) =>
  assistantAgentSchema.safeParse({ ...base, ...input }).success;

test('agent name: no control characters; description: no U+0000', () => {
  assert.equal(ok({ name: 'Synthetic helper', description: 'Line one.\nLine two.' }), true);
  for (const name of ['bad\u0000name', 'tab\tname', 'bell\u0007', 'del\u007f', 'a\nb'])
    assert.equal(ok({ name }), false, JSON.stringify(name));
  assert.equal(ok({ name: 'Synthetic helper', description: 'nul \u0000 inside' }), false);
  // A name that only ends in a line break is trimmed first and stays valid.
  assert.equal(ok({ name: 'Synthetic helper\n' }), true);
});
