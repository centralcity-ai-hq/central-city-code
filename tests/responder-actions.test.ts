import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResponderAction } from '../server/responder/actions.js';

test('one bounded task or pin is parsed without accepting authority selectors', () => {
  assert.deepEqual(
    parseResponderAction([{ name: 'room_task_create', arguments: { title: ' Work ' } }]),
    {
      name: 'room_task_create',
      arguments: { title: 'Work' },
    },
  );
  assert.deepEqual(
    parseResponderAction([{ name: 'room_pin', arguments: { seq: 7, note: ' Note ' } }]),
    {
      name: 'room_pin',
      arguments: { seq: 7, note: 'Note' },
    },
  );
  for (const field of ['roomId', 'agentId', 'ownerId', 'workspaceId']) {
    assert.equal(
      parseResponderAction([{ name: 'room_pin', arguments: { seq: 7, [field]: 'other' } }]),
      null,
    );
  }
});

test('unknown, multiple, malformed and oversized actions fail closed', () => {
  const valid = { name: 'room_pin', arguments: { seq: 1 } };
  for (const calls of [
    null,
    {},
    [],
    [valid, valid],
    [{ ...valid, extra: true }],
    [{ name: 'withdraw', arguments: {} }],
    [{ name: 'room_pin', arguments: '{"seq":1}' }],
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((seq) => [
      { name: 'room_pin', arguments: { seq } },
    ]),
    [{ name: 'room_task_create', arguments: { title: ' ' } }],
    [{ name: 'room_task_create', arguments: { title: 'x'.repeat(121) } }],
    [{ name: 'room_task_create', arguments: { title: 'ok', details: 'x'.repeat(2001) } }],
    [{ name: 'room_pin', arguments: { seq: 1, note: 'x'.repeat(201) } }],
  ])
    assert.equal(parseResponderAction(calls), null);
});
