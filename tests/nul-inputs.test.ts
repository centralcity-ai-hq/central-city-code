import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantJobSchema, grantSchema } from '../server/assistant-access.js';
import { requestConnectionToolInput } from '../server/connections/service.js';
import { remoteInputSchemas } from '../server/remote-mcp/tools.js';
import { createWorkspaceKeyToolInput } from '../server/workspaces/service.js';

/*
 * Text that is saved as jsonb (job input) or into a text column (connection note, key and grant
 * labels) refuses U+0000 in Postgres: such text answers 400 / invalid_arguments, never a 500.
 */

const requesterId = '00000000-0000-4000-8000-000000000001';
const providerId = '00000000-0000-4000-8000-000000000002';

test('job input (REST and city_create_job): no U+0000', () => {
  const job = (input: string) => ({
    requesterId,
    providerId,
    input,
    idempotencyKey: 'synthetic-key-1',
  });
  for (const schema of [assistantJobSchema, remoteInputSchemas.city_create_job]) {
    assert.equal(schema.safeParse(job('Line one.\nLine two.')).success, true);
    assert.equal(schema.safeParse(job('bad \u0000 input')).success, false);
  }
});

test('connection note: no U+0000', () => {
  const request = (note: string) => ({
    from_agent_id: requesterId,
    to_agent_id: providerId,
    note,
    idempotency_key: 'synthetic-key-2',
  });
  assert.equal(requestConnectionToolInput.safeParse(request('Hello there.')).success, true);
  assert.equal(requestConnectionToolInput.safeParse(request('Hi\u0000')).success, false);
});

test('workspace key and grant labels: no U+0000', () => {
  assert.equal(createWorkspaceKeyToolInput.safeParse({ label: 'Synthetic key' }).success, true);
  assert.equal(createWorkspaceKeyToolInput.safeParse({ label: 'bad\u0000key' }).success, false);
  const validGrant = { scopes: ['workspace:read'], expiresInDays: 7 };
  const grant = (label: string) => grantSchema.safeParse({ ...validGrant, label }).success;
  assert.equal(grant('Synthetic grant'), true);
  assert.equal(grant('bad\u0000grant'), false);
});
