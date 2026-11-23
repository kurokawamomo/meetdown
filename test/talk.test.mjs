// Timing rules of push-to-talk / tap-to-toggle (page/talk.js), run with fake time and a fake microphone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTalkMachine, createTalk } from '../page/talk.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- The state machine alone ----
function rig(holdMs = 300) {
  let t = 0;
  const log = [];
  const changes = [];
  const machine = createTalkMachine({
    holdMs,
    now: () => t,
    effects: { press: () => log.push('press'), start: () => log.push('start'), stop: (send) => log.push('stop:' + send) },
    onChange: (state, error) => changes.push(error ? state + '!' : state),
  });
  return { machine, log, changes, at: (ms) => { t = ms; } };
}

test('a tap keeps recording; the next tap stops and sends, without a second barge-in', () => {
  const r = rig();
  r.machine.down('pointer');
  r.at(100);
  r.machine.up('pointer');
  assert.equal(r.machine.state, 'toggled');
  r.at(5000);
  r.machine.down('pointer');
  assert.equal(r.machine.state, 'toggled'); // the stop tap is still down
  r.at(5600); // however long the second press lasts, it is a tap
  r.machine.up('pointer');
  assert.equal(r.machine.state, 'idle');
  assert.deepEqual(r.log, ['press', 'start', 'stop:true']);
  assert.deepEqual(r.changes, ['holding', 'toggled', 'idle']);
});

test('a hold sends on release; the limit is holdMs', () => {
  const r = rig(300);
  r.machine.down('key');
  r.at(299);
  r.machine.up('key');
  assert.equal(r.machine.state, 'toggled');
  const s = rig(300);
  s.machine.down('key');
  s.at(300);
  s.machine.up('key');
  assert.equal(s.machine.state, 'idle');
  assert.deepEqual(s.log, ['press', 'start', 'stop:true']);
});

test('holdMs may be a function read at each release', () => {
  let limit = 1000;
  const r = rig(() => limit);
  r.machine.down('key');
  r.at(500);
  r.machine.up('key');
  assert.equal(r.machine.state, 'toggled');
});

test('only the input that is down counts', () => {
  const r = rig();
  r.machine.down('pointer');
  r.machine.down('key'); // ignored: the button is already down
  r.machine.up('key'); // ignored: not the one that is down
  assert.equal(r.machine.state, 'holding');
  r.at(900);
  r.machine.up('pointer');
  assert.equal(r.machine.state, 'idle');
  assert.deepEqual(r.log, ['press', 'start', 'stop:true']);
});

test('a press is ignored while the talk is not enabled', () => {
  let on = false;
  const log = [];
  const machine = createTalkMachine({ enabled: () => on, effects: { press: () => log.push('press'), start: () => log.push('start') } });
  machine.down('key');
  machine.up('key');
  assert.equal(machine.state, 'idle');
  assert.deepEqual(log, []);
  on = true;
  machine.down('key');
  assert.equal(machine.state, 'holding');
});

test('a failure returns to idle with the error; the next press starts clean', () => {
  const r = rig();
  r.machine.down('pointer');
  r.machine.fail(new Error('no mic'));
  assert.equal(r.machine.state, 'idle');
  assert.equal(r.machine.error.message, 'no mic');
  r.machine.up('pointer'); // the finger was still down: ignored
  r.machine.down('pointer');
  assert.equal(r.machine.state, 'holding');
  assert.equal(r.machine.error, null);
});

// ---- createTalk with fake keys and a fake microphone ----
function fakeMic({ failWith, pendingStream } = {}) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; } });
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const made = { streams: 0, recorders: 0 };
  class Recorder {
    constructor(opts = {}) {
      made.recorders++;
      this.state = 'inactive';
      this.mimeType = ''; // like Chrome, the type is only known after start()
      this.empty = opts.empty;
    }
    start() {
      this.state = 'recording';
      this.mimeType = 'audio/test';
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        if (!this.empty) this.ondataavailable({ data: new Blob(['abc']) });
        this.onstop();
      });
    }
  }
  const media = {
    getStream: () => {
      made.streams++;
      if (failWith) return Promise.reject(failWith);
      return pendingStream ? pendingStream.then(() => stream) : Promise.resolve(stream);
    },
    createRecorder: () => new Recorder(),
  };
  return { media, made, track };
}

function talkRig(options = {}) {
  let t = 0;
  const events = [];
  const mic = fakeMic(options);
  const talk = createTalk({
    holdMs: 300,
    now: () => t,
    media: mic.media,
    isTyping: options.isTyping,
    onPress: () => events.push('press'),
    onSend: (blob, mime) => events.push('send:' + blob.size + ':' + mime),
    onCancel: () => events.push('cancel'),
    unlock: () => events.push('unlock'),
    onDiag: options.onDiag,
  });
  const target = new EventTarget();
  talk.bindKey(target);
  const changes = [];
  talk.onChange((state, error) => changes.push(error ? state + ':' + error.message : state));
  const key = (type, extra = {}) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code: 'Space', repeat: false, metaKey: false, ctrlKey: false, altKey: false }, extra));
  return { talk, events, mic, changes, key, at: (ms) => { t = ms; } };
}

test('Space: tap to start, tap to send; the microphone stream is opened once', async () => {
  const r = talkRig();
  r.key('keydown');
  r.at(80);
  r.key('keyup');
  await settle();
  assert.equal(r.talk.state, 'toggled');
  r.at(4000);
  r.key('keydown');
  r.at(4090);
  r.key('keyup');
  await settle();
  assert.equal(r.talk.state, 'idle');
  r.at(6000);
  r.key('keydown'); // a second recording
  await settle();
  r.at(7000);
  r.key('keyup');
  await settle();
  assert.deepEqual(r.events.filter((e) => e !== 'unlock'), ['press', 'send:3:audio/test', 'press', 'send:3:audio/test']);
  assert.equal(r.events[0], 'unlock'); // the first gesture unlocks audio
  assert.equal(r.mic.made.streams, 1);
});

test('Space: key repeats are ignored and a hold sends once on release', async () => {
  const r = talkRig();
  r.key('keydown');
  r.key('keydown', { repeat: true });
  r.key('keydown', { repeat: true });
  await settle();
  r.at(900);
  r.key('keyup');
  await settle();
  assert.deepEqual(r.events.filter((e) => e !== 'unlock'), ['press', 'send:3:audio/test']);
  assert.equal(r.talk.state, 'idle');
});

test('Space is left alone while typing, or with a modifier', async () => {
  const typing = talkRig({ isTyping: () => true });
  assert.equal(typing.key('keydown'), true); // dispatchEvent returns true when not default-prevented
  typing.key('keyup');
  assert.equal(typing.talk.state, 'idle');
  const idle = talkRig();
  assert.equal(idle.key('keydown', { ctrlKey: true }), true);
  assert.equal(idle.talk.state, 'idle');
  assert.equal(idle.key('keydown'), false); // taken by the talk button
  idle.key('keyup');
  await settle();
});

test('the microphone cannot start: onCancel, the error goes out through onChange, the next press retries', async () => {
  const r = talkRig({ failWith: new Error('denied') });
  r.key('keydown');
  r.at(700);
  r.key('keyup');
  await settle();
  assert.equal(r.talk.state, 'idle');
  assert.equal(r.talk.error.message, 'denied');
  assert.deepEqual(r.events.filter((e) => e !== 'unlock'), ['press', 'cancel']);
  assert.ok(r.changes.includes('idle:denied'));
  r.key('keydown');
  r.key('keyup');
  await settle();
  assert.equal(r.mic.made.streams, 2);
});

test('released before the microphone was ready: nothing is sent', async () => {
  let ready;
  const r = talkRig({ pendingStream: new Promise((resolve) => { ready = resolve; }) });
  r.key('keydown');
  r.at(1500);
  r.key('keyup'); // a hold, but the microphone has not started yet
  assert.equal(r.talk.state, 'idle');
  ready();
  await settle();
  assert.deepEqual(r.events.filter((e) => e !== 'unlock'), ['press', 'cancel']);
  assert.equal(r.mic.made.recorders, 0);
});

test('the microphone is taken away during a recording', async () => {
  const r = talkRig();
  r.key('keydown');
  r.at(50);
  r.key('keyup');
  await settle();
  assert.equal(r.talk.state, 'toggled');
  r.mic.track.dispatchEvent(new Event('ended'));
  await settle();
  assert.equal(r.talk.state, 'idle');
  assert.equal(r.talk.error.message, 'The microphone stopped');
  assert.deepEqual(r.events.filter((e) => e !== 'unlock'), ['press', 'cancel']);
});

test('the button: primary pointer only; down and up work like the key', async () => {
  const r = talkRig();
  const button = Object.assign(new EventTarget(), { style: {}, setPointerCapture() {} });
  r.talk.bindButton(button);
  const pointer = (type, extra = {}) => button.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { button: 0, pointerId: 1 }, extra));
  pointer('pointerdown', { button: 2 }); // right click
  assert.equal(r.talk.state, 'idle');
  assert.equal(pointer('pointerdown'), false);
  assert.equal(r.talk.state, 'holding');
  await settle();
  r.at(1200);
  pointer('pointerup');
  pointer('lostpointercapture'); // fires after pointerup; must not matter
  await settle();
  assert.equal(r.talk.state, 'idle');
  assert.deepEqual(r.events.filter((e) => e !== 'unlock'), ['press', 'send:3:audio/test']);
});

test('diag: the microphone opening and closing are reported with the track settings', async () => {
  const seen = [];
  const r = talkRig({ onDiag: (e, d) => seen.push([e, d]) });
  r.mic.track.getSettings = () => ({ sampleRate: 48000, channelCount: 1, echoCancellation: true });
  r.key('keydown');
  await settle();
  r.at(400);
  r.key('keyup');
  await settle();
  r.talk.closeMic();
  const open = seen.find(([e]) => e === 'mic-open');
  assert.ok(open, 'mic-open');
  assert.deepEqual([open[1].tracks, open[1].sampleRate, open[1].echoCancellation, open[1].readyState], [1, 48000, true, 'live']);
  assert.ok(seen.some(([e]) => e === 'mic-close'), 'mic-close');
});

test('diag: a microphone that cannot be opened is reported with the reason', async () => {
  const seen = [];
  const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const r = talkRig({ failWith: err, onDiag: (e, d) => seen.push([e, d]) });
  r.key('keydown');
  await settle();
  const f = seen.find(([e]) => e === 'mic-open-failed');
  assert.deepEqual([f[1].name, f[1].message], ['NotAllowedError', 'Permission denied']);
});
