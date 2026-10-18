import test from 'node:test';
import assert from 'node:assert/strict';
import { TestRoot, button, elements, text } from './helpers/hook-render.js';

const { TaskStagesSection } = await import('../src/rooms/TaskStages.js');

/*
 * Room settings, Task stages: a failed load must not pass for "No stages". It says so and offers
 * Try again; the editable list (and Update stages) shows only once the room's stages are known.
 */

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('a failed stage load shows Try again, which loads the stages and then the form', async () => {
  const calls: string[] = [];
  let fail = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string) => {
    calls.push(String(path));
    return fail
      ? respond(500, { error: 'Something went wrong' })
      : respond(200, { stages: ['Building', 'Shipped'] });
  }) as typeof fetch;
  try {
    const root = new TestRoot(TaskStagesSection, { roomId: 'room_1', closed: false });
    await root.flush();
    assert.equal(calls.length, 1);
    assert.equal(
      elements(root.output).some((element) => element.type === 'form'),
      false,
      'no editable list while the stages are unknown',
    );
    assert.doesNotMatch(text(root.output), /No stages/);
    assert.ok(
      elements(root.output).some((element) => element.props.role === 'alert'),
      'the error is shown',
    );
    const retry = button(root.output, 'Try again');
    assert.ok(retry, 'a Try again button is drawn');

    fail = false;
    (retry.props.onClick as () => void)();
    await root.flush();
    assert.equal(calls.length, 2, 'Try again loads the stages again');
    assert.ok(elements(root.output).some((element) => element.type === 'form'));
    const inputs = elements(root.output).filter((element) => element.type === 'input');
    assert.deepEqual(
      inputs.map((input) => input.props.value),
      ['Building', 'Shipped'],
    );
    assert.equal(button(root.output, 'Try again'), undefined);
    root.unmount();
  } finally {
    globalThis.fetch = realFetch;
  }
});
