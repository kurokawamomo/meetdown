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
  createGain() { return { gain: { value: 1, linearRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
}

const flush = () => new Promise((r) => setTimeout(r, 5));
function setup(extra = {}) {
  contexts.length = 0;
  const ticks = [];
  const player = createPlayer({
    env: {
      AudioContext: FakeContext,
      renewOutput: true,
      setInterval: (fn) => { ticks.push(fn); return ticks.length; },
      clearInterval() {},
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
      ...extra,
    },
  });
  return { player, ticks };
}
const sentence = (id, extra = {}) => ({ id, seq: 0, url: '/a/' + id, gap: 0, last: true, from: 'Ann', text: 'hi', ...extra });

test('renewOutput does nothing before the first gesture made a context', () => {
  const { player } = setup();
  player.renewOutput();
  assert.equal(contexts.length, 0);
});

test('renewOutput closes the old context and makes a running new one', async () => {
  const { player } = setup();
  player.unlock();
  assert.equal(contexts.length, 1);
  player.renewOutput();
  await flush();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].closed, true);
  assert.equal(contexts[1].closed, false);
  assert.equal(contexts[1].state, 'running');
});

test('renewOutput is off outside Safari', () => {
  const { player } = setup({ renewOutput: false });
  player.unlock();
  player.renewOutput();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closed, false);
});

test('a sentence queued after the renewal plays on the new context', async () => {
  const { player } = setup();
  player.unlock();
  player.renewOutput();
  await flush();
  player.enqueue(sentence('u1'));
  await flush();
  assert.equal(contexts[0].sources.length, 0);
  assert.equal(contexts[1].sources.length, 1);
  assert.equal(contexts[1].sources[0].at, 0);
});

test('a sentence decoded while held is kept and plays on the new context', async () => {
  const { player } = setup();
  player.unlock();
  player.hold(true);
  player.enqueue(sentence('u1'));
  await flush();
  player.hold(false); // the microphone is released
  await flush();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].sources.length, 1);
});

test('the renewal waits while a sentence is scheduled and happens when it has ended', async () => {
  const { player } = setup();
  player.unlock();
  player.enqueue(sentence('u1'));
  await flush();
  const src = contexts[0].sources[0];
  player.renewOutput();
  assert.equal(contexts.length, 1, 'not while something is scheduled');
  contexts[0].currentTime = 2;
  src.onended();
  await flush();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].closed, true);
});

test('the renewal waits while the microphone is open', async () => {
  const { player } = setup();
  player.unlock();
  player.hold(true);
  player.renewOutput();
  assert.equal(contexts.length, 1);
  player.hold(false);
  await flush();
  assert.equal(contexts.length, 2);
});

test('the timeline restarts at zero after a renewal', async () => {
  const { player } = setup();
  player.unlock();
  player.enqueue(sentence('u1'));
  await flush();
  player.renewOutput();
  contexts[0].currentTime = 5;
  contexts[0].sources[0].onended();
  await flush();
  assert.equal(contexts.length, 2);
  player.enqueue(sentence('u2'));
  await flush();
  assert.equal(contexts[1].sources[0].at, 0);
});
