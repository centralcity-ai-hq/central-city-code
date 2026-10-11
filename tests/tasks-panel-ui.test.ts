import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TasksPanel } from '../src/rooms/TasksPanel.js';
import type { Member, Room } from '../src/rooms/api.js';

// "New task" follows the posting rules: members (people and their AIs) add tasks, a muted
// member reads only.
const room = (extra: Partial<Room> = {}) =>
  ({
    id: 'room-1',
    slug: 'room-1',
    name: 'Room',
    topic: '',
    role: 'member',
    closed: false,
    readOnly: false,
    history: 'full',
    member_count: 2,
    latest_seq: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  }) as Room;
const me = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Ann',
  kind: 'person',
  role: 'member',
  own: true,
  owner_label: 'Ann',
} as unknown as Member;
const render = (value: Room) =>
  renderToStaticMarkup(
    createElement(TasksPanel, {
      room: value,
      members: [me],
      state: { tasks: [], error: '', refresh: async () => {}, setTasks: () => {} } as never,
      onClose: () => {},
    }),
  );

test('a member who joined as a person sees New task', () => {
  assert.match(render(room()), /New task/);
});

test('a muted member does not see New task', () => {
  assert.doesNotMatch(render(room({ muted: true })), /New task/);
});

test('a closed room shows no New task', () => {
  assert.doesNotMatch(render(room({ closed: true })), /New task/);
});
