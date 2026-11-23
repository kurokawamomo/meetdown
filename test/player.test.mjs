import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../page/player.js';

// A stand-in for AudioContext: time moves only when a test moves it
const contexts = [];
class FakeContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.closed = false;
    this.sources = [];
    this.destination = {};
    this.decoded = 0;
    contexts.push(this);
  }
  resume() { if (!this.closed) { this.state = 'running'; this.onstatechange && this.onstatechange(); } return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  decodeAudioData(raw, ok, ng) {
    if (this.closed) { ng(new Error('closed')); return Promise.reject(new Error('closed')); }
    this.decoded++;
    const buf = { duration: 1 };
    ok(buf);
    return Promise.resolve(buf);
  }
  createBufferSource() {
    const src = { connect() {}, disconnect() {}, stop() {}, start: (at) => { src.at = at; }, buffer: null, onended: null };
    this.sources.push(src);
    return src;
  }
  createAnalyser() {
    const an = { fftSize: 1024, level: 0, connect() {}, disconnect() {}, getFloatTimeDomainData: (a) => a.fill(an.level) };
    this.analyser = an;
    return an;
  }
  createGain() { return { gain: { value: 1, linearRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
}

const clock = { t: 100000 };
const flush = () => new Promise((r) => setTimeout(r, 5));
function setup(extra = {}, opts = {}) {
  contexts.length = 0;
  const ticks = [];
  const player = createPlayer({
    ...opts,
    env: {
      AudioContext: FakeContext,
      renewOutput: true,
      now: () => clock.t,
      setInterval: (fn) => { ticks.push(fn); return ticks.length; },
      clearInterval() {},
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
      ...extra,
    },
  });
  return { player, ticks };
}
const sentence = (id, extra = {}) => ({ id, seq: 0, url: '/a/' + id, gap: 0, last: true, from: 'Ann', text: 'hi', ...extra });

test('renewOutput only marks: nothing is renewed outside a gesture', async () => {
  const { player } = setup();
  player.unlock();
  clock.t += 60000; // the last gesture is long gone (autoEnd, the release timer)
  player.renewOutput();
  await flush();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closed, false);
});

test('the next unlock renews the context and resumes the new one', async () => {
  const { player } = setup();
  player.unlock();
  clock.t += 60000;
  player.renewOutput();
  player.unlock(); // a gesture
  await flush();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].closed, true);
  assert.equal(contexts[1].state, 'running');
});

test('an unlock that is not a gesture does not renew', async () => {
  const { player } = setup();
  player.unlock();
  clock.t += 60000;
  player.renewOutput();
  player.unlock(false); // visibilitychange
  await flush();
  assert.equal(contexts.length, 1);
});

test('renewOutput before the first gesture, or outside Safari, marks nothing', () => {
  const a = setup();
  a.player.renewOutput();
  a.player.unlock();
  a.player.unlock();
  assert.equal(contexts.length, 1);
  const b = setup({ renewOutput: false });
  b.player.unlock();
  b.player.renewOutput();
  b.player.unlock();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closed, false);
});

test('released by hand: hold(false) right after a gesture renews before a sentence is scheduled', async () => {
  const { player } = setup();
  player.unlock();
  player.hold(true);
  player.enqueue(sentence('u1'));
  await flush();
  clock.t += 300;
  player.unlock(); // pointerup, the microphone is still held at this moment
  assert.equal(contexts.length, 1, 'held: not yet');
  player.hold(false);
  await flush();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].sources.length, 1);
});

test('released by autoEnd: hold(false) alone does not renew; the next gesture does, before anything plays', async () => {
  const { player } = setup();
  player.unlock();
  player.hold(true);
  clock.t += 20000;
  player.hold(false);
  await flush();
  assert.equal(contexts.length, 1);
  player.enqueue(sentence('u1'));
  await flush();
  assert.equal(contexts[0].sources.length, 1, 'it plays on the old context until a gesture');
  contexts[0].currentTime = 2;
  contexts[0].sources[0].onended();
  player.unlock();
  await flush();
  assert.equal(contexts.length, 2);
});

test('the renewal waits while a sentence is scheduled', async () => {
  const { player } = setup();
  player.unlock();
  player.enqueue(sentence('u1'));
  await flush();
  player.renewOutput();
  player.unlock();
  assert.equal(contexts.length, 1, 'not while something is scheduled');
  contexts[0].sources[0].onended();
  player.unlock();
  await flush();
  assert.equal(contexts.length, 2);
});

test('the renewal waits while the microphone is open', async () => {
  const { player } = setup();
  player.unlock();
  player.hold(true);
  player.renewOutput();
  player.unlock();
  assert.equal(contexts.length, 1);
  player.hold(false); // the gesture was fresh
  await flush();
  assert.equal(contexts.length, 2);
});

test('the timeline restarts at zero after a renewal', async () => {
  const { player } = setup();
  player.unlock();
  player.enqueue(sentence('u1'));
  await flush();
  contexts[0].currentTime = 5;
  contexts[0].sources[0].onended();
  player.renewOutput();
  player.unlock();
  await flush();
  assert.equal(contexts.length, 2);
  player.enqueue(sentence('u2'));
  await flush();
  assert.equal(contexts[1].sources[0].at, 0);
});

test('a sentence queued after the renewal plays on the new context', async () => {
  const { player } = setup();
  player.unlock();
  player.renewOutput();
  player.unlock();
  await flush();
  player.enqueue(sentence('u1'));
  await flush();
  assert.equal(contexts[0].sources.length, 0);
  assert.equal(contexts[1].sources.length, 1);
});

test('diag: the context, unlock, renewal and each sentence are reported with the context state', async () => {
  const events = [];
  const { player } = setup({}, { onDiag: (e, d) => events.push([e, d]) });
  player.unlock();
  assert.deepEqual(events.map(([e]) => e).slice(0, 3), ['ctx-create', 'unlock', 'ctx-state']);
  assert.equal(events[0][1].reason, 'unlock');
  assert.equal(events[0][1].analyser, true);
  assert.equal(events[0][1].ctx.gen, 1);
  assert.equal(events[1][1].gesture, true);
  player.enqueue(sentence('u1', { seq: 3 }));
  await flush();
  contexts[0].sources[0].onended();
  const start = events.find(([e]) => e === 'play-start')[1];
  assert.deepEqual([start.id, start.seq, start.from], ['u1', 3, 'Ann']);
  const end = events.find(([e]) => e === 'play-end')[1];
  assert.deepEqual([end.id, end.last, end.duration], ['u1', true, 1]);
  assert.equal(end.ctx.state, 'running');
});

test('diag: the level of what plays is measured in front of the speakers', async () => {
  const events = [];
  const { player, ticks } = setup({}, { onDiag: (e, d) => events.push([e, d]) });
  player.unlock();
  player.enqueue(sentence('u1'));
  await flush();
  contexts[0].analyser.level = 0.25;
  contexts[0].currentTime = 0.5;
  for (const fn of ticks) fn(); // the player's own timer
  contexts[0].analyser.level = 0;
  for (const fn of ticks) fn();
  contexts[0].sources[0].onended();
  const end = events.find(([e]) => e === 'play-end')[1];
  assert.equal(end.rmsMax, 0.25);
  assert.equal(end.samples >= 2, true);
  assert.equal(end.rmsMean < 0.25, true);
});

test('diag: a renewal reports its mark, the renewal itself and the new context', async () => {
  const events = [];
  const { player } = setup({}, { onDiag: (e, d) => events.push([e, d]) });
  player.unlock();
  player.renewOutput();
  player.unlock();
  await flush();
  const names = events.map(([e]) => e);
  assert.ok(names.includes('renew-mark'));
  assert.ok(names.includes('ctx-renew'));
  const created = events.filter(([e]) => e === 'ctx-create');
  assert.deepEqual(created.map(([, d]) => d.reason), ['unlock', 'renew']);
  assert.equal(created[1][1].ctx.gen, 2);
});

test('diag: a throwing reporter does not stop the player', async () => {
  const { player } = setup({}, { onDiag: () => { throw new Error('x'); } });
  player.unlock();
  player.enqueue(sentence('u1'));
  await flush();
  assert.equal(contexts[0].sources.length, 1);
});
