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
let stage = null; // created below; the player and the event handlers reach it late

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
  onSentence: (from, text) => stage && stage.showSpeech(from, text),
  onClear: (from) => stage && stage.clearSpeech(from),
  onMurmur: (id, from, text) => stage && stage.showMurmur(from, text),
});
store.on('audio', (a) => player.enqueue(a));
store.on('stop', () => player.stopAll());

// ---- Thoughts and murmurs ----
// A thought is shown as text only and is never read out.
store.on('thought', (d) => {
  if (d && d.name && stage) stage.showThought(d.name, d.text || '');
});
store.on('murmur', (d) => {
  if (d && d.name && d.text && stage) stage.showMurmur(d.name, d.text); // before the audio is ready
});
store.on('inviteAsk', (d) => {
  const names = (d && d.names) || [];
  if (!names.length || !bar || typeof bar.askInvite !== 'function') return;
  bar.askInvite(
    names,
    () => { for (const name of names) post('/api/invite-confirm', { name }); },
    () => post('/api/invite-decline', {}),
  );
});

store.on('utterance', (u) => {
  if (u && (u.play === 'cut' || u.play === 'dropped')) player.silence(u.id);
});

// ---- Push to talk ----
const turnsWithText = new Set(); // turns that already produced some text
async function sendRecording(blob, mime, info = {}) {
  const { turn = '', part = 0, final = true } = info;
  const quiet = !final; // only the last part reports to the person
  if (final) say(ui().transcribing, TRANSCRIBING_MS);
  try {
    const q = new URLSearchParams({ turn, part: String(part), final: final ? '1' : '0' });
    const res = await fetch('/api/talk?' + q, { method: 'POST', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: blob });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) throw new Error((d && d.error) || 'HTTP ' + res.status);
    if (d.text) turnsWithText.add(turn);
    if (final) {
      say(d.error || (d.text || turnsWithText.has(turn) ? '' : ui().unheard));
      turnsWithText.delete(turn);
    }
  } catch (e) {
    if (!quiet) say((ui().sendError || '') + e.message);
  }
}

const talk = createTalk({
  holdMs: () => store.state.holdMs,
  interimSeconds: () => store.state.interimSeconds,
  autoEnd: () => store.state.autoEnd,
  enabled: () => !['closing', 'closed'].includes(store.state.meeting && store.state.meeting.state), // nothing to say to a finished meeting
  unlock: player.unlock,
  onPress: () => post('/api/press', player.stopAll(), { quiet: true }), // barge-in: stop the voices and tell the server what was cut
  onSend: sendRecording,
  onCancel: () => post('/api/cancel', {}, { quiet: true }),
  onLevel: (level) => bar && typeof bar.setLevel === 'function' && bar.setLevel(level),
});
talk.onChange((state, error) => {
  player.hold(state !== 'idle'); // no AI voice while the microphone is open
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

// Release the microphone while another window has focus. An open voice-processing stream (echo cancellation)
// makes other apps on the same machine record near silence, so a dictation tool in another window loses its words.
// The stream is opened again on the next press.
const releaseMic = () => setTimeout(() => { if (talk.state === 'idle') talk.closeMic(); }, 500);
window.addEventListener('blur', releaseMic);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseMic(); });

// ---- Views ----
stage = safely('stage', () => createStage(mount('stage'), {
  store,
  talk,
  avatarFor,
  onDismiss: (name) => post('/api/dismiss', { name }),
  onShareClose: () => post('/api/share-close', {}),
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
