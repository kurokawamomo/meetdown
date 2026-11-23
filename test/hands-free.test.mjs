import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartDetector, listenOver, createTalkMachine, HANDS_FREE_DEFAULTS } from '../page/talk.js';
import { charCount, tooShort } from '../lib/char-count.mjs';

const GATE = { threshold: 0.35, ms: 400 };

test('a loud level that lasts startMs is speech; a short burst is not', () => {
  const d = createStartDetector();
  assert.equal(d.feed(0.1, 0, GATE), 'none');
  assert.equal(d.feed(0.5, 50, GATE), 'maybe');
  assert.equal(d.feed(0.5, 300, GATE), 'maybe');
  assert.equal(d.feed(0.5, 450, GATE), 'speech');
});

test('a dip shorter than the gap does not break the run, a longer one does', () => {
  const d = createStartDetector({ gapMs: 200 });
  d.feed(0.5, 0, GATE);
  assert.equal(d.feed(0.1, 100, GATE), 'maybe'); // quiet for 100 ms only
  assert.equal(d.feed(0.5, 200, GATE), 'maybe');
  assert.equal(d.feed(0.1, 300, GATE), 'maybe');
  assert.equal(d.feed(0.1, 600, GATE), 'none'); // 400 ms since the last loud tick
  assert.equal(d.feed(0.5, 650, GATE), 'maybe'); // a new run starts from here
  assert.equal(d.feed(0.5, 1100, GATE), 'speech');
});

test('the AI voice playing raises the bar: a level that starts a run in silence is only a maybe', () => {
  const d = createStartDetector();
  const speaking = { threshold: 0.6, ms: 600 };
  assert.equal(d.feed(0.4, 0, speaking), 'none'); // the echo is below the raised threshold
  assert.equal(d.feed(0.4, 800, speaking), 'none');
  assert.equal(d.feed(0.7, 900, speaking), 'maybe');
  assert.equal(d.feed(0.7, 1500, speaking), 'speech');
});

test('reset forgets a run', () => {
  const d = createStartDetector();
  d.feed(0.5, 0, GATE);
  d.reset();
  assert.equal(d.feed(0.1, 500, GATE), 'none');
});

test('listenOver: quiet long enough after speech, or the longest recording', () => {
  const base = { startedAt: 0, quietMs: 1000, maxMs: 30000 };
  assert.equal(listenOver({ ...base, quietSince: null, now: 5000 }), false);
  assert.equal(listenOver({ ...base, quietSince: 4500, now: 5000 }), false);
  assert.equal(listenOver({ ...base, quietSince: 4000, now: 5000 }), true);
  assert.equal(listenOver({ ...base, quietSince: null, now: 30000 }), true);
  assert.equal(listenOver({ startedAt: 0, quietSince: 0, now: 99999, quietMs: 0, maxMs: 0 }), false); // both off
});

test('charCount counts letters and digits, not spaces or punctuation', () => {
  assert.equal(charCount('うん。'), 2);
  assert.equal(charCount(' ... 。 '), 0);
  assert.equal(charCount('OK, go 2'), 5);
  assert.equal(charCount(null), 0);
});

test('tooShort: below min is dropped; min 0 or missing keeps everything', () => {
  assert.equal(tooShort('はい', 4), true);
  assert.equal(tooShort('はい、そうです', 4), false);
  assert.equal(tooShort('', 4), true);
  assert.equal(tooShort('', 0), false);
  assert.equal(tooShort('', undefined), false);
});

test('the defaults match the numbers in the README', () => {
  assert.deepEqual(HANDS_FREE_DEFAULTS, { enabled: true, startLevel: 0.35, startMs: 400, speakingLevel: 0.6, speakingMs: 600, minChars: 4, quietSeconds: 1, maxSeconds: 30 });
});

// ---- the state machine ----
function rig({ handsFree = true } = {}) {
  let t = 0;
  const log = [];
  const m = createTalkMachine({
    holdMs: 300,
    now: () => t,
    handsFree: () => handsFree,
    onChange: (s) => log.push(s),
    effects: {
      press: () => log.push('press'),
      start: () => log.push('start'),
      stop: (send) => log.push(`stop:${send}`),
      listen: () => log.push('listen'),
      unlisten: () => log.push('unlisten'),
    },
  });
  const tap = (from = 'pointer') => { m.down(from); t += 50; m.up(from); };
  return { m, log, tap, at: (v) => { t = v; } };
}

test('a tap opens the recording, the next tap sends it and the microphone keeps listening', () => {
  const { m, log, tap, at } = rig();
  tap();
  assert.equal(m.state, 'toggled');
  at(1000);
  tap();
  assert.equal(m.state, 'listening');
  assert.deepEqual(log, ['holding', 'press', 'start', 'toggled', 'listening', 'stop:true', 'listen']);
});

test('a tap while listening closes the microphone', () => {
  const { m, log, tap, at } = rig();
  tap(); at(1000); tap(); at(2000);
  log.length = 0;
  tap();
  assert.equal(m.state, 'idle');
  assert.deepEqual(log, ['idle', 'unlisten']);
});

test('press and hold works as before: released after holdMs it sends and goes idle', () => {
  const { m, log, at } = rig();
  m.down('pointer');
  at(1000);
  m.up('pointer');
  assert.equal(m.state, 'idle');
  assert.ok(!log.includes('listen'));
});

test('the turn ending by itself (end) from a toggled recording goes to listening; from holding it goes idle', () => {
  const a = rig();
  a.tap();
  a.m.end();
  assert.equal(a.m.state, 'listening');
  const b = rig();
  b.m.down('pointer');
  b.m.end();
  assert.equal(b.m.state, 'idle');
});

test('handsFree off: a toggled recording ends in idle as before', () => {
  const { m, tap, at } = rig({ handsFree: false });
  tap(); at(1000); tap();
  assert.equal(m.state, 'idle');
});

test('end does nothing while listening; leave closes it; fail closes it with the error', () => {
  const a = rig();
  a.tap(); a.m.end();
  a.m.end();
  assert.equal(a.m.state, 'listening');
  a.m.leave();
  assert.equal(a.m.state, 'idle');
  assert.equal(a.log.at(-1), 'unlisten');
  const b = rig();
  b.tap(); b.m.end();
  b.m.fail(new Error('gone'));
  assert.equal(b.m.state, 'idle');
  assert.equal(b.m.error.message, 'gone');
  assert.equal(b.log.at(-1), 'unlisten');
});

// ---- createTalk: listening with a fake microphone, a fake level meter and hand-driven ticks ----
import { createTalk } from '../page/talk.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function listenRig({ speaking = false } = {}) {
  let t = 0;
  let rms = 0;
  let isSpeaking = speaking;
  const events = [];
  const tickers = new Set();
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; } });
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = ''; }
    start() { this.state = 'recording'; this.mimeType = 'audio/test'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable({ data: new Blob(['abc']) }); this.onstop(); }); }
  }
  const talk = createTalk({
    holdMs: 300,
    now: () => t,
    media: { getStream: () => Promise.resolve(stream), createRecorder: () => new Recorder(), createMeter: () => ({ read: () => rms, close() {} }) },
    timers: { setInterval: (fn) => { tickers.add(fn); return fn; }, clearInterval: (id) => tickers.delete(id) },
    isTyping: () => false,
    isSpeaking: () => isSpeaking,
    onHear: (on) => events.push(on ? 'hear' : 'unhear'),
    onPress: () => events.push('press'),
    onSend: (blob, mime, info) => events.push(`send:${info.min}:${info.final}`),
    onCancel: () => events.push('cancel'),
    onDiag: (e) => events.push(`diag:${e}`),
    handsFree: { quietSeconds: 1 },
  });
  const target = new EventTarget();
  talk.bindKey(target);
  const key = (type) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code: 'Space', repeat: false, metaKey: false, ctrlKey: false, altKey: false }));
  const tap = async () => { key('keydown'); t += 50; key('keyup'); await settle(); };
  // advance by ms in 50 ms ticks at the given raw RMS (level = rms * 4)
  const run = async (ms, level) => {
    rms = level / 4;
    for (let i = 0; i < ms / 50; i++) { t += 50; for (const fn of [...tickers]) fn(); }
    await settle();
  };
  return { talk, events, tap, run, setSpeaking: (v) => { isSpeaking = v; }, at: () => t };
}

async function intoListening(r) {
  await r.tap(); // open the recording
  await r.run(100, 0);
  await r.tap(); // send it
  assert.equal(r.talk.state, 'listening');
  r.events.length = 0;
}

test('listening: a loud stretch that lasts cuts the AI voice and is sent with min once the human is quiet', async () => {
  const r = listenRig();
  await intoListening(r);
  await r.run(500, 0.6);
  assert.ok(r.events.includes('press') && r.events.includes('hear') && r.events.includes('diag:listen-speech'));
  await r.run(1200, 0);
  assert.ok(r.events.includes('unhear'));
  assert.ok(r.events.includes('send:4:true'));
  assert.equal(r.talk.state, 'listening'); // still listening afterwards
});

test('listening: a short burst is dropped without a send and without cutting the voice', async () => {
  const r = listenRig();
  await intoListening(r);
  await r.run(150, 0.6);
  await r.run(600, 0);
  assert.deepEqual(r.events.filter((e) => !e.startsWith('diag:')), []);
  assert.ok(r.events.includes('diag:listen-discard'));
});

test('listening: while the AI voice plays, a level that would start speech in silence does not', async () => {
  const r = listenRig({ speaking: true });
  await intoListening(r);
  await r.run(1000, 0.5); // above startLevel (0.35), below speakingLevel (0.6)
  assert.equal(r.events.includes('press'), false);
  await r.run(700, 0.8); // louder than the echo can be
  assert.equal(r.events.includes('press'), true);
});

test('listening: a tap closes it, and nothing more is sent', async () => {
  const r = listenRig();
  await intoListening(r);
  await r.tap();
  assert.equal(r.talk.state, 'idle');
  await r.run(2000, 0.9);
  assert.equal(r.events.some((e) => e === 'press' || e.startsWith('send')), false);
  assert.ok(r.events.includes('diag:listen-stop'));
});
