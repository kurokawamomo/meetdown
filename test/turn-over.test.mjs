import test from 'node:test';
import assert from 'node:assert/strict';
import { turnOver, createTalkMachine } from '../page/talk.js';

const rule = { afterMs: 15000, quietMs: 5000 };

test('a long talk followed by a long silence ends the turn', () => {
  assert.equal(turnOver({ startedAt: 0, quietSince: 15000, now: 20000, ...rule }), true);
});

test('a short talk or a short silence does not end the turn', () => {
  assert.equal(turnOver({ startedAt: 0, quietSince: 5000, now: 10000, ...rule }), false);
  assert.equal(turnOver({ startedAt: 0, quietSince: 17000, now: 20000, ...rule }), false);
  assert.equal(turnOver({ startedAt: 0, quietSince: null, now: 60000, ...rule }), false);
});

test('the rule is off when either value is missing or zero', () => {
  assert.equal(turnOver({ startedAt: 0, quietSince: 0, now: 60000, afterMs: 0, quietMs: 5000 }), false);
  assert.equal(turnOver({ startedAt: 0, quietSince: 0, now: 60000, afterMs: 15000, quietMs: NaN }), false);
});

test('end() stops and sends a toggled recording, and the late key up is ignored', () => {
  const calls = [];
  const m = createTalkMachine({ now: () => 0, effects: { press: () => calls.push('press'), start: () => calls.push('start'), stop: (s) => calls.push('stop:' + s) } });
  m.down('key');
  m.end();
  m.up('key');
  assert.equal(m.state, 'idle');
  assert.deepEqual(calls, ['press', 'start', 'stop:true']);
});
