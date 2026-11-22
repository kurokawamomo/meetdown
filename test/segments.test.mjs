// Interim segments, input level and pause detection of page/talk.js (pure parts and a fake microphone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTalk, rmsOf, segmentDue, createPauseDetector } from '../page/talk.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('rmsOf', () => {
  assert.equal(rmsOf([]), 0);
  assert.equal(rmsOf(null), 0);
  assert.ok(Math.abs(rmsOf([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9);
});

test('segmentDue: after the interval, never when disabled', () => {
  assert.equal(segmentDue({ startedAt: 1000, now: 15999, intervalMs: 15000 }), false);
  assert.equal(segmentDue({ startedAt: 1000, now: 16000, intervalMs: 15000 }), true);
  assert.equal(segmentDue({ startedAt: 0, now: 1e9, intervalMs: 0 }), false);
  assert.equal(segmentDue({ startedAt: 0, now: 1e9, intervalMs: NaN }), false);
});

test('pause detector: quiet for 800 ms is a pause, a loud sample ends it, a blip restarts the count', () => {
  const d = createPauseDetector({ threshold: 0.02, holdMs: 800 });
  assert.equal(d.feed(0.001, 0), false);
  assert.equal(d.feed(0.001, 799), false);
  assert.equal(d.feed(0.001, 800), true);
  assert.equal(d.feed(0.001, 900), true);
  assert.equal(d.feed(0.1, 950), false);
  assert.equal(d.feed(0.001, 1000), false);
  assert.equal(d.feed(0.001, 1799), false);
  assert.equal(d.feed(0.001, 1800), true);
  d.reset();
  assert.equal(d.paused, false);
});

function rig({ levels = [] } = {}) {
  let t = 0;
  const sent = [];
  const events = [];
  let ticker = null;
  let level = 0;
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() {} });
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  let n = 0;
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = ''; this.n = ++n; }
    start() { this.state = 'recording'; this.mimeType = 'audio/test'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable({ data: new Blob(['x'.repeat(this.n)]) }); this.onstop(); });
    }
  }
  const media = { getStream: async () => stream, createRecorder: () => new Recorder(), createMeter: () => ({ read: () => level, close() {} }) };
  const talk = createTalk({
    holdMs: 300,
    interimSeconds: 15,
    now: () => t,
    media,
    timers: { setInterval: (fn) => { ticker = fn; return 1; }, clearInterval: () => { ticker = null; } },
    onPress: () => {},
    onSend: (blob, mime, info) => sent.push({ size: blob.size, ...info }),
    onCancel: () => events.push('cancel'),
    onLevel: (l) => events.push('level:' + l.toFixed(2)),
    onPause: (p) => events.push('pause:' + p),
  });
  const target = new EventTarget();
  talk.bindKey(target);
  const key = (type) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code: 'Space', repeat: false, metaKey: false, ctrlKey: false, altKey: false }));
  return { talk, sent, events, key, at: (ms) => { t = ms; }, tick: () => ticker && ticker(), setLevel: (l) => { level = l; } };
}

test('a long recording is cut every interval into parts of one turn; release sends the final part', async () => {
  const r = rig();
  r.key('keydown');
  await settle();
  r.at(14000); r.tick(); await settle();
  assert.equal(r.sent.length, 0);
  r.at(15000); r.tick(); await settle();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].part, 0);
  assert.equal(r.sent[0].final, false);
  r.at(29000); r.tick(); await settle();
  assert.equal(r.sent.length, 1);
  r.at(30000); r.tick(); await settle();
  assert.equal(r.sent.length, 2);
  r.at(31000);
  r.key('keyup');
  await settle();
  assert.deepEqual(r.sent.map((s) => [s.part, s.final]), [[0, false], [1, false], [2, true]]);
  assert.equal(new Set(r.sent.map((s) => s.turn)).size, 1);
  assert.ok(r.sent[0].turn.length >= 8);
  assert.equal(r.tick(), null); // the ticker stopped
});

test('a new press is a new turn starting at part 0', async () => {
  const r = rig();
  r.key('keydown'); await settle(); r.at(900); r.key('keyup'); await settle();
  r.key('keydown'); await settle(); r.at(2000); r.key('keyup'); await settle();
  assert.equal(r.sent.length, 2);
  assert.notEqual(r.sent[0].turn, r.sent[1].turn);
  assert.deepEqual(r.sent.map((s) => [s.part, s.final]), [[0, true], [0, true]]);
});

test('level and pause are reported while recording; the pause ends with sound and when recording ends', async () => {
  const r = rig();
  r.key('keydown'); await settle();
  r.setLevel(0.1); r.at(100); r.tick();
  r.setLevel(0.001); r.at(200); r.tick();
  r.at(1000); r.tick();
  assert.ok(r.events.includes('level:0.40'));
  assert.ok(r.events.includes('pause:true'));
  r.at(1100);
  r.key('keyup'); await settle();
  assert.equal(r.events.at(-2), 'pause:false');
  assert.equal(r.events.at(-1), 'level:0.00');
});

test('an empty final part is still sent when earlier parts went out', async () => {
  const r = rig();
  r.key('keydown'); await settle();
  r.at(15000); r.tick(); await settle();
  assert.equal(r.sent.length, 1);
  r.at(15100); r.key('keyup'); await settle();
  assert.equal(r.sent.at(-1).final, true);
});
