import assert from 'node:assert/strict';
import test from 'node:test';
import { mutePosting, mutedNotice } from '../src/rooms/muteView.js';

/*
 * A muted member gets the muted notice instead of a composer that every post would fail from
 * (muteView.ts, RoomView). A bulk "Mute all AIs" still lets the owner post as a person.
 */

const agent = { id: 'a1', kind: 'agent' as const };
const person = { id: 'p1', kind: 'person' as const };

test('not muted: every own member may post', () => {
  assert.deepEqual(mutePosting({}, [agent, person]), { blocked: false, posters: [agent, person] });
});

test('a full mute (or an older server without a scope) blocks the composer', () => {
  assert.deepEqual(mutePosting({ muted: true, muteScope: 'all' }, [agent, person]), {
    blocked: true,
    posters: [],
  });
  assert.equal(mutePosting({ muted: true }, [agent, person]).blocked, true);
});

test('an AI-only mute leaves only the person member, and blocks when there is none', () => {
  assert.deepEqual(mutePosting({ muted: true, muteScope: 'ai' }, [agent, person]), {
    blocked: false,
    posters: [person],
  });
  assert.deepEqual(mutePosting({ muted: true, muteScope: 'ai' }, [agent]), {
    blocked: true,
    posters: [],
  });
});

test('the notice quotes the host reason only when there is one', () => {
  assert.equal(
    mutedNotice(null),
    'The host muted you in this room. You can still read, but not post.',
  );
  assert.match(mutedNotice('Too many pings'), /Their reason: “Too many pings”$/);
});

test('"Mute all AIs" that spares the person (muted false, scope ai): only the person may post', () => {
  assert.deepEqual(mutePosting({ muted: false, muteScope: 'ai' }, [agent, person]), {
    blocked: false,
    posters: [person],
  });
  assert.deepEqual(mutePosting({ muteScope: 'ai' }, [person, agent]), {
    blocked: false,
    posters: [person],
  });
});
