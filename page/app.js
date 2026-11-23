// meetdown page entry. The server's event stream (store) drives push-to-talk, voice playback and the
// three views (stage, bar, panel); the user's actions go back to the HTTP API. All requests are
// same-origin, so the cookie carries the token.
import { createCaptions } from './captions.js';
import { createPeople } from './people.js';
import { createStore } from './store.js';
import { createTalk } from './talk.js';
import { createPlayer } from './player.js';
import { createDiag } from './diag.js';
import { createStage } from './stage.js';
import { createBar } from './bar.js';
import { createPanel } from './panel.js';
import { avatarFor } from './avatar/index.js';

const TRANSCRIBING_MS = 15000; // "transcribing" stays until the answer arrives, but not forever

// What the page's audio is doing, reported to the server (state/audio-diag.jsonl) to find out why a voice can go silent
const diag = createDiag();
diag.log('page-open', { href: location.pathname, hidden: document.hidden });

const store = createStore('/events'); // store.state.connected is false while the stream is down; the bar shows that itself
const ui = () => store.state.ui;
let bar = null;
let stage = null;
let captions = null; // created below; the player and the event handlers reach it late

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
  onSentence: (from, text) => {
    if (stage) stage.showSpeech(from, text);
    if (captions) captions.sentence(from, text);
  },
  onClear: (from) => stage && stage.clearSpeech(from),
  onMurmur: (id, from, text) => stage && stage.showMurmur(from, text),
  onDiag: diag.log,
});
const queuedAudio = new Set(); // id/seq of sentences this page already has; a reconnect replays the unheard ones
store.on('audio', (a) => {
  const key = a && `${a.id}/${a.seq}`;
  if (!a || queuedAudio.has(key)) return;
  queuedAudio.add(key);
  player.enqueue(a);
});
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
    if (info.min) q.set('min', String(info.min)); // hands-free: the server drops a transcript shorter than this
    const res = await fetch('/api/talk?' + q, { method: 'POST', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: blob });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) throw new Error((d && d.error) || 'HTTP ' + res.status);
    if (d.text) turnsWithText.add(turn);
    if (d.dropped) { // hands-free: too short to be speech, back to listening
      diag.log('listen-discard', { reason: 'chars', chars: [...d.text].length });
      say('');
      turnsWithText.delete(turn);
    } else if (final) {
      say(d.error || (d.text || turnsWithText.has(turn) ? '' : ui().unheard));
      turnsWithText.delete(turn);
    }
  } catch (e) {
    if (!quiet) say((ui().sendError || '') + e.message);
  }
}

let hearing = false;
const syncHold = () => player.hold(talk.state !== 'idle' && (talk.state !== 'listening' || hearing)); // listening lets the AI voice play
const talk = createTalk({
  holdMs: () => store.state.holdMs,
  interimSeconds: () => store.state.interimSeconds,
  autoEnd: () => store.state.autoEnd,
  handsFree: () => store.state.handsFree,
  isSpeaking: () => (store.state.speaking || []).length > 0, // the AI voice is audible: its echo must not count as the human
  onHear: (on) => { hearing = on; syncHold(); }, // a speech start was detected: keep the AI voice quiet until the recording is sent
  enabled: () => !['closing', 'closed'].includes(store.state.meeting && store.state.meeting.state), // nothing to say to a finished meeting
  unlock: player.unlock,
  onDiag: diag.log,
  onPress: () => post('/api/press', player.stopAll(), { quiet: true }), // barge-in: stop the voices and tell the server what was cut
  onSend: sendRecording,
  onCancel: () => post('/api/cancel', {}, { quiet: true }),
  onLevel: (level) => {
    player.setInputLevel(level);
    if (bar && typeof bar.setLevel === 'function') bar.setLevel(level);
  },
});
talk.onChange((state, error) => {
  syncHold(); // no AI voice while the microphone records; while it only listens, the AI voice may play
  if (error) say((ui().micError || '') + error.message);
});
talk.bindKey(document);

// Audio can only start after a gesture; every kind of gesture tries again
for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(type, player.unlock, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => { diag.log('visibility', { hidden: document.hidden }); if (!document.hidden) player.unlock(false); }); // not a gesture
window.addEventListener('pagehide', () => { diag.log('pagehide', {}); diag.flush(); });
window.addEventListener('focus', () => diag.log('focus', { focus: true }));
window.addEventListener('blur', () => diag.log('focus', { focus: false }));
store.on('connected', () => diag.log('sse', { connected: true }));
store.on('disconnected', () => diag.log('sse', { connected: false }));

// ---- Meeting changes ----
let meetingId = null;
store.on('snapshot', () => {
  const id = store.state.meeting && store.state.meeting.id;
  if (id !== meetingId) {
    if (meetingId !== null) { player.reset(); queuedAudio.clear(); } // a new meeting restarts utterance ids
    meetingId = id;
  }
});
store.on('meeting', (m) => {
  if (m && m.state === 'closed') { talk.closeMic(); player.renewOutput(); } // Safari: the output can go silent after the microphone was used
});

// Release the microphone while another window has focus. An open voice-processing stream (echo cancellation)
// makes other apps on the same machine record near silence, so a dictation tool in another window loses its words.
// The stream is opened again on the next press.
const releaseMic = () => setTimeout(() => { if (talk.state === 'idle') { talk.closeMic(); player.renewOutput(); } }, 500); // renewOutput: Safari can lose its output after the microphone was used
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
}));
safely('panel', () => createPanel(mount('panel'), { store }));
captions = safely('captions', () => createCaptions(mount('captions'), { store }));
safely('people', () => createPeople(mount('people'), {
  store,
  fetchLive,
  onDismiss: (name) => post('/api/dismiss', { name }),
  onInvite: (name) => post('/api/invite', { name }),
  onBaton: (name) => post('/api/baton', { name }),
}));
