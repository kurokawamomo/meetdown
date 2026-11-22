// meetdown server: HTTP, page updates (SSE) and the wiring between the meeting parts in lib/.
// The center is the utterance log (lib/meeting.mjs). Everyone hears everything; the baton (lib/focus.mjs) says who answers by voice.
// Listens on 127.0.0.1 only and answers nothing without the token.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Roster } from './lib/roster.mjs';
import { Meeting } from './lib/meeting.mjs';
import { resolveBaton, findInvites } from './lib/focus.mjs';
import { createThoughts } from './lib/thoughts.mjs';
import { createCourier } from './lib/courier.mjs';
import { createSpeech } from './lib/speech.mjs';
import { summarize } from './lib/summary.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const OWNER = CONFIG.owner || 'the user';
const DRY = CONFIG.dryDeliver || process.env.MEETDOWN_DRY === '1'; // for testing: log deliveries instead of sending them
const UI = {
  you: 'You', meeting: 'Meeting', talk: 'Talk', placeholder: 'Type a message', send: 'Send',
  idle: 'idle', busy: 'working', absent: 'away', chair: 'chair', cut: 'cut off', dropped: 'not played', error: 'no voice',
  transcribing: 'Transcribing...', unheard: 'Could not catch that', micError: 'Microphone unavailable: ',
  sendError: 'Could not send: ', reconnecting: 'Disconnected. Reconnecting...',
  paneMissing: 'Could not find the pane of {name}', gaveUp: 'Could not deliver to {name} ({why})',
  invite: 'Add people', inviteTitle: 'Add a session', noOneToInvite: 'No session to add', more: 'More',
  leave: 'Leave', leaving: 'Ending the meeting in {seconds} s', back: 'Back', ended: 'The meeting has ended',
  summary: 'Summary', summaryFailed: 'Could not summarize', dismiss: 'Remove', minutes: 'Minutes', joined: 'joined', left: 'left',
  baton: 'Baton', inviteAsk: 'Invite {name}?', inviteYes: 'Invite', inviteNo: 'Not now', dismissConfirm: 'Remove {name} from the meeting?',
  dismissYes: 'Remove', dismissNo: 'Cancel', sharing: '{name} is presenting', passed: '{from} passed the baton to {to}', stopShare: 'Stop sharing', unpinShare: 'Unpin', pinShare: 'Pin', interim: 'Still talking', murmur: 'Murmur',
  noReply: 'No spoken reply', toggled: 'Recording (tap to send)', holding: 'Recording (release to send)',
  ...(CONFIG.ui || {}),
};
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const GRACE_MS = (CONFIG.leaveGraceSeconds ?? 10) * 1000;
const MURMUR_MAX = CONFIG.murmurMaxChars ?? 30; // a murmur cuts into the human's talk, so it stays short
// tmux-foxhound's pane delivery, found in whichever plugin marketplace has it installed
const MARKETS = path.join(os.homedir(), '.claude/plugins/marketplaces');
const PANE_MODULE = fs.readdirSync(MARKETS).map((m) => path.join(MARKETS, m, 'plugins/tmux-foxhound/skills/tmux-foxhound/scripts/foxhound-pane.mjs')).find((f) => fs.existsSync(f));
if (!PANE_MODULE) throw new Error('tmux-foxhound (foxhound-pane.mjs) was not found under ' + MARKETS);
const STATE = path.join(ROOT, 'state');
const AUDIO = path.join(STATE, 'audio');
const MEETINGS = path.join(ROOT, 'meetings');
const PAGE_DIR = path.join(ROOT, 'page');
const SHARES = path.join(STATE, 'share');
const SAY = path.join(ROOT, 'bin/meet-say').replace(os.homedir(), '~');
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(MEETINGS, { recursive: true });
fs.mkdirSync(SHARES, { recursive: true });

const logFile = path.join(STATE, 'server.log');
const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch (_) {}
};

// Entry token, created on first start and readable only by the owner
const TOKEN_FILE = path.join(ROOT, '.token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('base64url') + '\n', { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const same = (a) => typeof a === 'string' && a.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(TOKEN));
const cookieToken = (req) => ((req.headers.cookie || '').match(/(?:^|;\s*)meetdown=([^;]+)/) || [])[1];


// ---- Parts ----
const { sendToPane } = await import(pathToFileURL(PANE_MODULE).href);
const send = (pane, text, opts = {}) => (DRY ? (log('dry-deliver', pane, text), Promise.resolve(true)) : sendToPane(pane, text, { log: (...a) => log('pane', ...a), ...opts }));
const courier = createCourier({
  send, sayPath: SAY, owner: OWNER, log,
  // Undelivered messages leave a note in the minutes (not for shares, which retry on every tick)
  onFail: ({ kind, label, why }) => {
    if (kind === 'interim' || !meeting) return;
    note(why === 'no-pane' ? fill(UI.paneMissing, { name: label }) : fill(UI.gaveUp, { name: label, why }));
  },
});
process.env.MEETDOWN_SPEED = String(CONFIG.speechSpeed ?? 1); // read by tts_worker.py
const speech = createSpeech({ stateDir: STATE, audioDir: AUDIO, log });
const roster = new Roster({
  sessionsDir: path.join(os.homedir(), '.claude/sessions'),
  people: CONFIG.people || {},
  voicePool: CONFIG.voicePool || [],
});
// What each participant is doing right now, read from its Claude Code transcript (the "thought" balloon)
const thoughts = createThoughts({ sessionsDir: path.join(os.homedir(), '.claude/sessions'), projectsDir: path.join(os.homedir(), '.claude/projects'), log });
const thoughtText = new Map(); // name -> latest thought
// A new thought is also voiced, very short and quiet (the page plays it at low volume and fades it out), at most
// once per THOUGHT_VOICE_GAP_MS per participant; thoughtVoice: false in config.json turns it off
const THOUGHT_VOICE_CHARS = 20;
const THOUGHT_VOICE_GAP_MS = 10000;
const thoughtVoicedAt = new Map(); // name -> time
thoughts.on('thought', ({ name, text }) => {
  thoughtText.set(name, text);
  emit('thought', { name, text });
  const p = roster.byName(name);
  if (CONFIG.thoughtVoice === false || !text || !p || !inMeeting(name) || meeting.info().state !== 'open') return;
  if (Date.now() - (thoughtVoicedAt.get(name) || 0) < THOUGHT_VOICE_GAP_MS) return;
  thoughtVoicedAt.set(name, Date.now());
  const said = [...text].slice(0, THOUGHT_VOICE_CHARS).join('');
  const u = meeting.append(entry({ kind: 'murmur', from: name, text: said, thought: true, play: 'queued' }));
  murmurIds.add(u.id);
  thoughtIds.add(u.id);
  speech.speak(u.id, forSpeech(said), p.voice, p.style);
});

// ---- Meeting state that lives outside the log: baton holders, interim turns, invites waiting for a yes, screen share ----
let meeting = null;
let baton = [];
const unheard = new Map(); // utterance id -> audio events
// Words that send the baton to someone, added from the panes (meet-say --route): kept ones live in a file, once ones end with the meeting
const ROUTES = path.join(STATE, 'routes.json');
const keptRoutes = (() => { try { return JSON.parse(fs.readFileSync(ROUTES, 'utf8')) || {}; } catch (_) { return {}; } })(); // word -> name
const onceRoutes = new Map(); // word -> name; wins over a kept route of the same word
function withRoutes(people) {
  const to = new Map(Object.entries(keptRoutes));
  for (const [w, n] of onceRoutes) to.set(w, n);
  const extra = new Map();
  for (const [w, n] of to) { if (!extra.has(n)) extra.set(n, []); extra.get(n).push(w); }
  return people.map((p) => (extra.has(p.name) ? { ...p, aliases: [...(p.aliases || []), ...extra.get(p.name)] } : p));
}
const turns = new Map(); // turn id -> { parts: Map(part -> text), u: live interim utterance }
const askedInvites = new Set();
let share = null;
let shareVersion = 0;
const murmurIds = new Set(); // utterance ids spoken at half volume
const thoughtIds = new Set(); // murmurs that voice a thought: quieter, fading, allowed over the human
const awaiting = new Map(); // name -> { since: id, sawBusy: boolean }

const chairName = () => (roster.participants().find((p) => p.chair) || {}).name || null;
const inMeeting = (name) => roster.participants().some((p) => p.name === name);
const labelOf = (name) => (roster.byName(name) || {}).label || name;
// look.image is a local file path in config.json: the page only gets an opaque url for it
const AVATAR_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const avatarImages = new Map(); // url id -> file path
function publicLook(look = {}) {
  const { image, ...rest } = look;
  const file = typeof image === 'string' ? image.replace(/^~(?=\/)/, process.env.HOME || '~') : '';
  const ext = path.extname(file).toLowerCase();
  if (!file || !AVATAR_TYPES[ext]) return rest;
  const id = crypto.createHash('sha1').update(file).digest('hex').slice(0, 12) + ext;
  avatarImages.set(id, file);
  return { ...rest, imageUrl: '/avatar-image/' + id };
}
const publicParticipant = (p) => ({ name: p.name, label: p.label, status: p.status, chair: !!p.chair, look: publicLook(p.look || {}), address: p.address, title: p.title });
const rosterPayload = () => ({ participants: roster.participants().map(publicParticipant), baton });
// A participant leaves (removed by the human, or saying goodbye on its own) and is told so
async function dismiss(name) {
  const p = roster.byName(name);
  if (!p || !inMeeting(name)) return;
  roster.leave(name);
  baton = baton.filter((n) => n !== name);
  watchThoughts();
  awaiting.delete(name);
  meeting.append(entry({ kind: 'leave', from: name, text: UI.left }));
  emitRoster();
  await courier.dismiss(meeting, p);
}
const leavingAfter = new Map(); // utterance id -> name: the goodbye is heard to the end, then the speaker leaves
const LEAVE_FALLBACK_MS = 30000; // leave anyway when no page reports the goodbye as heard

// Who was in the meeting, kept so a restarted server brings them back into the new meeting
const LAST_PARTICIPANTS = path.join(STATE, 'last-participants.json');
function rememberParticipants() {
  const names = roster.participants().map((p) => p.name);
  if (names.length && meeting && meeting.info().state === 'open') fs.writeFileSync(LAST_PARTICIPANTS, JSON.stringify(names));
}
const lastParticipants = () => { try { return JSON.parse(fs.readFileSync(LAST_PARTICIPANTS, 'utf8')) || []; } catch (_) { return []; } };
const emitRoster = () => { rememberParticipants(); emit('roster', rosterPayload()); emit('baton', { holders: baton }); };
const watchThoughts = () => thoughts.watch(roster.participants().map((p) => p.name));
const entry = (fields) => ({ to: [], maybe: [], aside: false, ...fields });
const note = (text) => meeting.append(entry({ kind: 'note', from: 'system', text }));

function openMeeting() {
  meeting = new Meeting({ dir: MEETINGS });
  meeting.on('utterance', (u) => emit('utterance', u));
  meeting.on('state', (info) => emit('meeting', info));
  meeting.on('expire', () => endMeeting().catch((e) => log('end', e.stack || e.message)));
  baton = [];
  unheard.clear();
  onceRoutes.clear();
  turns.clear();
  askedInvites.clear();
  share = null;
  murmurIds.clear();
  thoughtIds.clear();
  awaiting.clear();
  roster.poll();
  const auto = CONFIG.autoJoin || [];
  const back = lastParticipants().filter((n) => !auto.includes(n));
  roster.reset([...auto, ...back]);
  for (const p of roster.participants()) if (back.includes(p.name)) courier.greet(meeting, roster, p);
  watchThoughts();
  log('meeting open', meeting.info().id);
  emit('snapshot', snapshot());
}

async function endMeeting() {
  if (!meeting || meeting.info().state !== 'leaving') return;
  meeting.setState('closing');
  fs.rmSync(LAST_PARTICIPANTS, { force: true }); // the owner left: the next meeting starts with the auto-join names only
  const lines = meeting.list
    .filter((u) => ['voice', 'text', 'say', 'murmur'].includes(u.kind) && u.text && !u.thought)
    .map((u) => ({ label: u.from === 'human' ? OWNER : labelOf(u.from), text: u.text, aside: !!u.aside, kind: u.kind }));
  const text = lines.length ? await summarize({ meetingId: meeting.info().id, lines, claudeBin: CONFIG.claudeBin || 'claude' }) : null;
  if (text) {
    meeting.append(entry({ kind: 'summary', from: 'system', to: roster.participants().map((p) => p.name), text }));
    await courier.summary(meeting, roster, text);
  } else {
    note(UI.summaryFailed);
  }
  meeting.close(text || UI.summaryFailed);
  emit('summary', { text: text || UI.summaryFailed });
  log('meeting closed', meeting.info().id, text ? 'with summary' : 'without summary');
}

// ---- Page updates (Server-Sent Events) ----
const clients = new Set();
function emit(type, data) {
  const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(s);
}
const snapshot = () => ({
  meeting: meeting.info(), list: meeting.list, ...rosterPayload(), ui: UI, lang: CONFIG.lang || 'en',
  overlap: CONFIG.overlapSeconds ?? 0, holdMs: CONFIG.holdMs ?? 300, interimSeconds: CONFIG.interimSeconds ?? [15, 20, 25], autoEnd: CONFIG.autoEnd ?? { afterSeconds: 15, quietSeconds: 5 },
  me: { owner: OWNER }, share, thoughts: Object.fromEntries(thoughtText),
});
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000).unref();

// ---- Roster polling: status changes drive "thinking" faces and the "no spoken reply" note ----
roster.on('change', () => {
  for (const [name, w] of awaiting) {
    const p = roster.byName(name);
    if (!p) { awaiting.delete(name); continue; }
    if (p.status === 'busy') w.sawBusy = true;
    else if (w.sawBusy && p.status === 'idle') {
      awaiting.delete(name);
      meeting.append(entry({ kind: 'no_reply', from: name, text: UI.noReply }));
    }
  }
  watchThoughts();
  emitRoster();
});
setInterval(() => roster.poll(), 3000).unref();

// ---- Talking ----
const unwrap = (raw) => raw.replace(/^\u300c([^\u300c\u300d]*)\u300d$/, '$1'); // whisper may wrap a Japanese sentence in corner brackets

// A spoken "bring in X" only asks; the page shows a chip and the human confirms
function askInvites(text) {
  const people = CONFIG.people || {};
  const others = roster.live().filter((s) => !inMeeting(s.name))
    .map((s) => ({ ...s, label: (people[s.name] || {}).label || s.title || s.name, aliases: (people[s.name] || {}).aliases || [] }));
  const names = findInvites({ text, live: others, inviteWords: CONFIG.inviteWords || [], sessionReadings: CONFIG.sessionReadings || {} })
    .filter((n) => !askedInvites.has(n));
  if (!names.length) return;
  names.forEach((n) => askedInvites.add(n));
  emit('inviteAsk', { names });
}

async function human(kind, raw) {
  if (meeting.info().state !== 'open') return; // nothing reaches the panes while the meeting is ending
  const text = unwrap(raw);
  askInvites(text);
  const r = resolveBaton({
    text, participants: withRoutes(roster.participants()), holders: baton, chairName: chairName(),
    everyoneWords: CONFIG.everyoneWords || [], sessionReadings: CONFIG.sessionReadings || {},
  });
  baton = r.holders;
  const u = meeting.append(entry({ kind, from: 'human', to: baton, maybe: r.maybe, text }));
  for (const name of r.named) emit('signal', { name, kind: 'called' });
  emitRoster();
  const sent = await courier.broadcast(meeting, roster, u, baton);
  for (const name of sent.filter((n) => baton.includes(n))) awaiting.set(name, { since: u.id, sawBusy: false });
}

// One recording piece of a long turn: show it live and tell everyone that the human is still talking
async function interimPart(turnId, part, text) {
  const t = turns.get(turnId) || { parts: new Map(), u: null };
  turns.set(turnId, t);
  if (!text) return;
  t.parts.set(part, unwrap(text));
  const sofar = [...t.parts.keys()].sort((a, b) => a - b).map((k) => t.parts.get(k)).join(' ');
  if (t.u) meeting.update(t.u, { text: sofar });
  else t.u = meeting.append(entry({ kind: 'interim', from: 'human', text: sofar, turn: turnId }));
  emit('interim', { turn: turnId, part, text: unwrap(text), at: new Date().toISOString() });
  askInvites(text);
  const sent = await courier.interim(meeting, roster, unwrap(text), turnId);
  for (const name of sent) emit('signal', { name, kind: 'shared' });
}

// VOICEVOX reads a space as a pause, so drop spaces next to Japanese text (kana, kanji, full-width forms) before speaking.
// The minutes keep the original text.
const JA = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';
const SPACE_NEAR_JA = new RegExp(`(?<=[${JA}])[ \\t]+|[ \\t]+(?=[${JA}])`, 'g');
const forSpeech = (text) => text.replace(SPACE_NEAR_JA, '');

// ---- Speech output ----
// Sentences of utterances that are not heard to the end yet, so a reloaded page can play them again
const stillToHear = (u) => u && (u.play === 'queued' || u.play === 'playing');
speech.on('audio', (m) => {
  const u = meeting.list.find((x) => x.id === m.id);
  if (stillToHear(u)) {
    const a = { id: m.id, seq: m.seq, url: '/audio/' + m.file, gap: m.gap, last: m.last, from: u.from, text: m.text || '', murmur: murmurIds.has(m.id), thought: thoughtIds.has(m.id) };
    if (!unheard.has(m.id)) unheard.set(m.id, []);
    unheard.get(m.id).push(a);
    emit('audio', a);
  }
});
const REPLAY_WINDOW_MS = 60000; // only what was said in the last minute comes back after a reload
function replayUnheard(res) {
  for (const [id, list] of unheard) {
    const u = meeting.list.find((x) => x.id === id);
    if (!stillToHear(u) || Date.now() - Date.parse(u.at) > REPLAY_WINDOW_MS) { unheard.delete(id); continue; }
    for (const a of list) res.write(`event: audio\ndata: ${JSON.stringify(a)}\n\n`);
  }
}
speech.on('error', (m) => {
  const u = meeting.list.find((x) => x.id === m.id);
  log('tts error', m.id, m.error);
  if (u) meeting.update(u, { play: 'error' });
});

// ---- HTTP ----
const read = (req, limit) => new Promise((resolveBody, reject) => {
  const parts = [];
  let size = 0;
  req.on('data', (b) => { size += b.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(b); });
  req.on('end', () => resolveBody(Buffer.concat(parts)));
  req.on('error', reject);
});
const json = async (req) => JSON.parse(String(await read(req, 64 * 1024)) || '{}');
const sendRes = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const ok = (res) => sendRes(res, 200, { ok: true });
const TYPES = { '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.jpeg': 'image/jpeg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

const routes = {
  // Pressed: start loading whisper, stop the voice being played and drop the rest
  'POST /api/press': async (req, res) => {
    const { playing, pending = [] } = await json(req);
    speech.start();
    const cut = playing && meeting.list.find((x) => x.id === playing.id);
    if (cut && cut.kind === 'say') { meeting.update(cut, { play: 'cut', cutAt: playing.seq }); emit('signal', { name: cut.from, kind: 'cut' }); }
    const synth = [...speech.pending()];
    const drop = new Set([...synth, ...pending.map(Number)]);
    if (cut) drop.delete(cut.id);
    if (synth.length) speech.cancelSynth(synth);
    for (const id of drop) {
      const u = meeting.list.find((x) => x.id === id);
      if (u && u.kind === 'say' && (u.play === 'queued' || u.play === 'playing')) meeting.update(u, { play: 'dropped' });
    }
    emit('stop', {});
    ok(res);
  },
  'POST /api/cancel': async (req, res) => { speech.cancel(); ok(res); },
  // Released: transcribe the recording and deliver it
  // Released, or one piece of a long turn (?turn=&part=&final=): transcribe it; pieces are broadcast as interim text
  'POST /api/talk': async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const turnId = url.searchParams.get('turn');
    const part = Number(url.searchParams.get('part') || 0);
    const final = !turnId || url.searchParams.get('final') === '1';
    const r = await speech.transcribe(await read(req, speech.maxAudio));
    if (r.error) { emit('note', { text: r.error }); return sendRes(res, 200, { error: r.error }); }
    const text = (r.text || '').trim();
    sendRes(res, 200, { text, ms: r.ms });
    if (!final) return interimPart(turnId, part, text);
    const t = turnId && turns.get(turnId);
    if (t && text) t.parts.set(part, unwrap(text));
    const full = t ? [...t.parts.keys()].sort((a, b) => a - b).map((k) => t.parts.get(k)).join(' ') : text;
    if (t) { if (t.u) meeting.update(t.u, { done: true }); turns.delete(turnId); }
    if (!full) return emit('note', { text: UI.unheard });
    await human('voice', full);
  },
  'POST /api/text': async (req, res) => {
    const text = String((await json(req)).text || '').trim();
    ok(res);
    if (text) await human('text', text);
  },
  'POST /api/play': async (req, res) => {
    const { id, state } = await json(req);
    const u = meeting.list.find((x) => x.id === id);
    const next = { queued: ['playing', 'done'], playing: ['done'] };
    if (u && (next[u.play] || []).includes(state)) meeting.update(u, { play: state });
    if (state === 'done' && leavingAfter.has(id)) { const name = leavingAfter.get(id); leavingAfter.delete(id); await dismiss(name); }
    ok(res);
  },
  // A spoken invite was confirmed or declined on the page
  'POST /api/invite-confirm': async (req, res) => {
    const { name } = await json(req);
    askedInvites.delete(name);
    const p = inMeeting(name) ? null : roster.join(name);
    ok(res);
    if (p) {
      meeting.append(entry({ kind: 'join', from: name, text: UI.joined }));
      watchThoughts();
      emitRoster();
      await courier.greet(meeting, roster, p);
    }
  },
  'POST /api/invite-decline': async (req, res) => { const { name } = await json(req); if (name) askedInvites.delete(name); else askedInvites.clear(); ok(res); },
  'GET /api/live': async (req, res) => sendRes(res, 200, roster.live().filter((s) => !inMeeting(s.name))),
  'POST /api/invite': async (req, res) => {
    const { name } = await json(req);
    const p = inMeeting(name) ? null : roster.join(name);
    ok(res);
    if (p) {
      meeting.append(entry({ kind: 'join', from: name, text: UI.joined }));
      emitRoster();
      watchThoughts();
      await courier.greet(meeting, roster, p);
    }
  },
  'POST /api/dismiss': async (req, res) => {
    const { name } = await json(req);
    ok(res);
    await dismiss(name);
  },
  // From the People panel: talk to this participant only (the baton goes to it alone)
  'POST /api/baton': async (req, res) => {
    const { name } = await json(req);
    if (inMeeting(name)) { baton = [name]; emit('baton', { holders: baton }); }
    ok(res);
  },
  'POST /api/leave': async (req, res) => { if (meeting.info().state === 'open') meeting.leave(GRACE_MS); ok(res); },
  'POST /api/back': async (req, res) => { if (meeting.info().state === 'leaving') meeting.back(); ok(res); },
  // From an AI pane (meet-say --route): this word sends the baton to that participant, kept or for this meeting only
  'POST /api/route': async (req, res) => {
    const { pane, word, to, once, remove } = await json(req);
    if (!roster.byPane(pane)) return sendRes(res, 403, 'this pane is not a participant of the meeting', 'text/plain; charset=utf-8');
    const w = String(word || '').trim();
    if (!w) return sendRes(res, 400, 'give a word', 'text/plain; charset=utf-8');
    if (remove) {
      onceRoutes.delete(w);
      delete keptRoutes[w];
    } else {
      const target = roster.byName(to);
      if (!target) return sendRes(res, 400, `unknown participant: ${to}`, 'text/plain; charset=utf-8');
      if (once) onceRoutes.set(w, target.name);
      else keptRoutes[w] = target.name;
    }
    fs.writeFileSync(ROUTES, JSON.stringify(keptRoutes, null, 2));
    sendRes(res, 200, { note: remove ? `"${w}" no longer routes` : `"${w}" now sends the baton to ${roster.byName(to).name}${once ? ' (this meeting only)' : ''}` });
  },
  // From an AI pane (meet-say): speak (big balloon) or murmur (small balloon, half volume); optionally pass the baton
  'POST /api/say': async (req, res) => {
    const { pane, text, pass, kind, leave } = await json(req);
    const p = roster.byPane(pane);
    if (!p || !inMeeting(p.name) || meeting.info().state === 'closed') return sendRes(res, 403, 'this pane is not a participant of the meeting', 'text/plain; charset=utf-8');
    const t = String(text || '').trim();
    if (!t) return sendRes(res, 400, 'nothing to say', 'text/plain; charset=utf-8');
    const murmur = kind === 'murmur';
    if (murmur && [...t].length > MURMUR_MAX) return sendRes(res, 400, `a murmur is at most ${MURMUR_MAX} characters (this one has ${[...t].length}); shorten it, or wait for the baton and speak`, 'text/plain; charset=utf-8');
    awaiting.delete(p.name);
    const u = meeting.append(entry({ kind: murmur ? 'murmur' : 'say', from: p.name, text: t, play: 'queued' }));
    if (murmur) { murmurIds.add(u.id); emit('murmur', { name: p.name, id: u.id, text: t }); }
    speech.speak(u.id, forSpeech(t), p.voice, p.style);
    if (leave) {
      leavingAfter.set(u.id, p.name);
      setTimeout(() => { if (leavingAfter.delete(u.id)) dismiss(p.name); }, LEAVE_FALLBACK_MS);
    }
    sendRes(res, 200, { note: `${murmur ? 'murmured' : 'spoken'} in the meeting (utterance ${u.id})${leave ? '; you leave once it is heard' : ''}` });
    if (pass && inMeeting(pass) && pass !== p.name) {
      baton = [pass];
      meeting.append(entry({ kind: 'pass', from: p.name, to: [pass], text: t }));
      emitRoster();
      emit('signal', { name: pass, kind: 'called' });
      await courier.passed(meeting, roster, p.name, pass, t);
    }
  },
  // From the page: the human closes whatever is shared; the presenter is told
  'POST /api/share-close': async (req, res) => {
    ok(res);
    if (!share) return;
    const by = share.by;
    share = null;
    emit('share', null);
    meeting.append(entry({ kind: 'share', from: 'human', text: 'closed the share' }));
    const p = roster.byName(by);
    if (p && inMeeting(by)) await courier.shareClosed(meeting, p);
  },
  // From an AI pane (meet-say --share/--unshare/--scroll): show a file or a URL to everyone
  'POST /api/share': async (req, res) => {
    const { pane, path: file, url: link, caption = '', scroll, stop } = await json(req);
    const p = roster.byPane(pane);
    if (!p || !inMeeting(p.name)) return sendRes(res, 403, 'this pane is not a participant of the meeting', 'text/plain; charset=utf-8');
    if (stop) { share = null; emit('share', null); return sendRes(res, 200, { note: 'stopped sharing' }); }
    if (typeof scroll === 'number') { emit('scroll', { percent: Math.max(0, Math.min(100, scroll)) }); return sendRes(res, 200, { note: `scrolled to ${scroll}%` }); }
    let src, kindOf;
    if (link && /^https?:\/\//.test(link)) { src = link; kindOf = 'url'; }
    else if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      if (!TYPES[ext] || ['.js', '.css'].includes(ext)) return sendRes(res, 400, 'cannot share this file type', 'text/plain; charset=utf-8');
      const id = crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
      fs.copyFileSync(file, path.join(SHARES, id + ext));
      kindOf = ext === '.pdf' ? 'pdf' : ['.png', '.jpg', '.jpeg', '.svg'].includes(ext) ? 'image' : 'html';
      src = `/share/${id}${ext}`;
    } else return sendRes(res, 400, 'give an existing file path or an http(s) URL', 'text/plain; charset=utf-8');
    shareVersion += 1;
    share = { id: shareVersion, kind: kindOf, src: kindOf === 'url' ? src : `${src}?v=${shareVersion}`, caption, version: shareVersion, by: p.name };
    emit('share', share);
    meeting.append(entry({ kind: 'share', from: p.name, text: caption || path.basename(file || link) }));
    sendRes(res, 200, { note: 'sharing' });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    // A URL with the token: move it into a cookie and drop it from the URL
    const t = url.searchParams.get('t');
    if (req.method === 'GET' && url.pathname === '/' && t) {
      if (!same(t)) return sendRes(res, 403, 'forbidden', 'text/plain');
      res.writeHead(303, { 'Set-Cookie': `meetdown=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
      return res.end();
    }
    if (!same(cookieToken(req)) && !same(req.headers['x-token'])) return sendRes(res, 403, 'forbidden', 'text/plain');

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      replayUnheard(res); // after a reload, what was not heard to the end plays again (the page skips sentences it already has)
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const avatarImage = url.pathname.match(/^\/avatar-image\/([0-9a-f]{12}\.[a-z]+)$/);
    if (req.method === 'GET' && avatarImage) {
      const file = avatarImages.get(avatarImage[1]);
      if (!file || !fs.existsSync(file)) return sendRes(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': AVATAR_TYPES[path.extname(file).toLowerCase()], 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    const shared = url.pathname.match(/^\/share\/([0-9a-f]{12}\.[a-z]+)$/);
    if (req.method === 'GET' && shared) {
      const f = path.join(SHARES, shared[1]);
      return fs.existsSync(f) ? sendRes(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream') : sendRes(res, 404, 'not found', 'text/plain');
    }
    const audio = url.pathname.match(/^\/audio\/(\d+-\d+\.wav)$/);
    if (req.method === 'GET' && audio) {
      const f = path.join(AUDIO, audio[1]);
      return fs.existsSync(f) ? sendRes(res, 200, fs.readFileSync(f), 'audio/wav') : sendRes(res, 404, 'not found', 'text/plain');
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res);
    if (req.method === 'GET') {
      // A page load after the meeting ended starts the next meeting
      if (url.pathname === '/' && meeting.info().state === 'closed') openMeeting();
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(PAGE_DIR, rel);
      if (file.startsWith(PAGE_DIR + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return sendRes(res, 200, fs.readFileSync(file), TYPES[path.extname(file)]);
      }
    }
    sendRes(res, 404, 'not found', 'text/plain');
  } catch (e) {
    log('error', req.method, url.pathname, e.stack || e.message);
    if (!res.headersSent) sendRes(res, 500, { error: e.message });
  }
});

openMeeting();
server.listen(CONFIG.port, '127.0.0.1', () => log(`listening 127.0.0.1:${CONFIG.port}${DRY ? ' (dry-deliver)' : ''}`));
const quit = () => { speech.shutdown(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
