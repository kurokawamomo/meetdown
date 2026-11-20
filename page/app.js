// meetdown page entry. The server's event stream (store) drives push-to-talk, voice playback and the
// three views (stage, bar, panel); the user's actions go back to the HTTP API. All requests are
// same-origin, so the cookie carries the token.
import { createStore } from './store.js';
import { createTalk } from './talk.js';
import { createPlayer } from './player.js';
import { createStage } from './stage.js';
import { createBar } from './bar.js';
import { createPanel } from './panel.js';
import { avatarFor } from './avatar/index.js';

const TRANSCRIBING_MS = 15000; // "transcribing" stays until the answer arrives, but not forever

const store = createStore('/events'); // store.state.connected is false while the stream is down; the bar shows that itself
const ui = () => store.state.ui;
let bar = null;

// Local messages go through the bar's toast, which also shows the server's 'note' events
const say = (text, ms) => {
  if (bar && typeof bar.note === 'function') bar.note(text, ms);
  else if (text) console.warn(text);
};
const safely = (what, fn) => {
  try { return fn(); } catch (e) { console.error(what, e); return null; }
};
const mount = (id) => document.getElementById(id) || document.body.appendChild(Object.assign(document.createElement('div'), { id }));

async function post(url, body, { quiet = false } = {}) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    if (!res.ok && !quiet) say((ui().sendError || '') + res.status);
    return res;
  } catch (e) {
    if (!quiet) say((ui().sendError || '') + e.message);
    return null;
  }
}

async function fetchLive() {
  const res = await fetch('/api/live');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ---- Voice playback: the server says when an utterance starts and ends being heard ----
const player = createPlayer({
  overlap: () => store.state.overlap,
  onPlay: (id) => post('/api/play', { id, state: 'playing' }, { quiet: true }),
  onDone: (id) => post('/api/play', { id, state: 'done' }, { quiet: true }),
  onSpeaking: (names) => store.patch({ speaking: names }), // the stage shows these names as speaking
});
store.on('audio', (a) => player.enqueue(a));
store.on('stop', () => player.stopAll());
store.on('utterance', (u) => {
  if (u && (u.play === 'cut' || u.play === 'dropped')) player.silence(u.id);
});

// ---- Push to talk ----
async function sendRecording(blob, mime) {
  say(ui().transcribing, TRANSCRIBING_MS);
  try {
    const res = await fetch('/api/talk', { method: 'POST', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: blob });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) throw new Error((d && d.error) || 'HTTP ' + res.status);
    say(d.error || (d.text ? '' : ui().unheard));
  } catch (e) {
    say((ui().sendError || '') + e.message);
  }
}

const talk = createTalk({
  holdMs: () => store.state.holdMs,
  enabled: () => !['closing', 'closed'].includes(store.state.meeting && store.state.meeting.state), // nothing to say to a finished meeting
  unlock: player.unlock,
  onPress: () => post('/api/press', player.stopAll(), { quiet: true }), // barge-in: stop the voices and tell the server what was cut
  onSend: sendRecording,
  onCancel: () => post('/api/cancel', {}, { quiet: true }),
});
talk.onChange((state, error) => {
  player.hold(state !== 'idle'); // AI voices wait while the microphone is open
  if (error) say((ui().micError || '') + error.message);
});
talk.bindKey(document);

// Audio can only start after a gesture; every kind of gesture tries again
for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(type, player.unlock, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) player.unlock(); });

// ---- Meeting changes ----
let meetingId = null;
store.on('snapshot', () => {
  const id = store.state.meeting && store.state.meeting.id;
  if (id !== meetingId) {
    if (meetingId !== null) player.reset(); // a new meeting restarts utterance ids
    meetingId = id;
  }
});
store.on('meeting', (m) => {
  if (m && m.state === 'closed') talk.closeMic();
});

// ---- Views ----
safely('stage', () => createStage(mount('stage'), {
  store,
  talk,
  avatarFor,
  onFocus: (name) => post('/api/focus', { name }),
  onAside: (name) => post('/api/aside', { name }),
  onDismiss: (name) => post('/api/dismiss', { name }),
}));
bar = safely('bar', () => createBar(mount('bar'), {
  store,
  talk,
  fetchLive,
  onText: (text) => post('/api/text', { text }),
  onInvite: (name) => post('/api/invite', { name }),
  onLeave: () => post('/api/leave', {}),
  onBack: () => post('/api/back', {}),
  onTaste: (taste, name = '*') => post('/api/taste', { name, taste }),
}));
safely('panel', () => createPanel(mount('panel'), { store }));
