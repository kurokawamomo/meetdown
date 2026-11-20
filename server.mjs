// meetdown server: HTTP, page updates (SSE) and the wiring between the meeting parts in lib/.
// The center is the utterance log (lib/meeting.mjs); who hears what is decided by lib/focus.mjs.
// Listens on 127.0.0.1 only and answers nothing without the token.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Roster } from './lib/roster.mjs';
import { Meeting } from './lib/meeting.mjs';
import { resolve, findInvites } from './lib/focus.mjs';
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
  taste: 'Avatar style', tasteCritters: 'Critters', tasteMeet: 'Meet circles',
  leave: 'Leave', leaving: 'Ending the meeting in {seconds} s', back: 'Back', ended: 'The meeting has ended',
  summary: 'Summary', summaryFailed: 'Could not summarize', focus: 'Focus', aside: 'Aside', dismiss: 'Remove',
  asideNext: 'Next message only', minutes: 'Minutes', share: 'Shared', joined: 'joined', left: 'left',
  noReply: 'No spoken reply', toggled: 'Recording (tap to send)', holding: 'Recording (release to send)',
  ...(CONFIG.ui || {}),
};
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const TASTES = ['critters', 'meet'];
const SHARE_MS = (CONFIG.shareMinutes ?? 2) * 60000;
const GRACE_MS = (CONFIG.leaveGraceSeconds ?? 10) * 1000;
// tmux-foxhound's pane delivery, found in whichever plugin marketplace has it installed
const MARKETS = path.join(os.homedir(), '.claude/plugins/marketplaces');
const PANE_MODULE = fs.readdirSync(MARKETS).map((m) => path.join(MARKETS, m, 'plugins/tmux-foxhound/skills/tmux-foxhound/scripts/foxhound-pane.mjs')).find((f) => fs.existsSync(f));
if (!PANE_MODULE) throw new Error('tmux-foxhound (foxhound-pane.mjs) was not found under ' + MARKETS);
const STATE = path.join(ROOT, 'state');
const AUDIO = path.join(STATE, 'audio');
const MEETINGS = path.join(ROOT, 'meetings');
const PAGE_DIR = path.join(ROOT, 'page');
const PREFS = path.join(STATE, 'prefs.json');
const SAY = path.join(ROOT, 'bin/meet-say').replace(os.homedir(), '~');
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(MEETINGS, { recursive: true });

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

// Avatar taste choices survive restarts
const prefs = (() => { try { return { tastes: {}, ...JSON.parse(fs.readFileSync(PREFS, 'utf8')) }; } catch (_) { return { tastes: {} }; } })();
const savePrefs = () => fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 2));

// ---- Parts ----
const { sendToPane } = await import(pathToFileURL(PANE_MODULE).href);
const send = (pane, text, opts = {}) => (DRY ? (log('dry-deliver', pane, text), Promise.resolve(true)) : sendToPane(pane, text, { log: (...a) => log('pane', ...a), ...opts }));
const courier = createCourier({
  send, sayPath: SAY, owner: OWNER, log,
  // Undelivered messages leave a note in the minutes (not for shares, which retry on every tick)
  onFail: ({ kind, label, why }) => {
    if (kind === 'share' || !meeting) return;
    note(why === 'no-pane' ? fill(UI.paneMissing, { name: label }) : fill(UI.gaveUp, { name: label, why }));
  },
});
const speech = createSpeech({ stateDir: STATE, audioDir: AUDIO, log });
const roster = new Roster({
  sessionsDir: path.join(os.homedir(), '.claude/sessions'),
  people: CONFIG.people || {},
  voicePool: CONFIG.voicePool || [],
  defaultTaste: prefs.defaultTaste || CONFIG.defaultTaste || 'critters',
});

// ---- Meeting state that lives outside the log: focus (Z-targeting), aside, share clock, awaited replies ----
let meeting = null;
let focus = [];
let aside = null;
let lastShareAt = 0;
const awaiting = new Map(); // name -> { since: id, sawBusy: boolean }

const chairName = () => (roster.participants().find((p) => p.chair) || {}).name || null;
const inMeeting = (name) => roster.participants().some((p) => p.name === name);
const labelOf = (name) => (roster.byName(name) || {}).label || name;
const tasteOf = (p) => prefs.tastes[p.name] || prefs.defaultTaste || p.taste || CONFIG.defaultTaste || 'critters';
const publicParticipant = (p) => ({ name: p.name, label: p.label, status: p.status, chair: !!p.chair, taste: tasteOf(p), look: p.look || {}, address: p.address, title: p.title });
const rosterPayload = () => ({ participants: roster.participants().map(publicParticipant), focus, aside });
const entry = (fields) => ({ to: [], maybe: [], aside: false, ...fields });
const note = (text) => meeting.append(entry({ kind: 'note', from: 'system', text }));

function openMeeting() {
  meeting = new Meeting({ dir: MEETINGS });
  meeting.on('utterance', (u) => emit('utterance', u));
  meeting.on('state', (info) => emit('meeting', info));
  meeting.on('expire', () => endMeeting().catch((e) => log('end', e.stack || e.message)));
  focus = [];
  aside = null;
  lastShareAt = Date.now();
  awaiting.clear();
  roster.poll();
  roster.reset(CONFIG.autoJoin || []);
  log('meeting open', meeting.info().id);
  emit('snapshot', snapshot());
}

async function endMeeting() {
  if (!meeting || meeting.info().state !== 'leaving') return;
  meeting.setState('closing');
  const lines = meeting.list
    .filter((u) => ['voice', 'text', 'say'].includes(u.kind) && u.text)
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
  overlap: CONFIG.overlapSeconds ?? 1, holdMs: CONFIG.holdMs ?? 300, tastes: TASTES, me: { owner: OWNER },
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
  emit('roster', rosterPayload());
});
setInterval(() => roster.poll(), 3000).unref();

// ---- Talking ----
async function human(kind, raw) {
  if (meeting.info().state !== 'open') return; // nothing reaches the panes while the meeting is ending
  const text = raw.replace(/^\u300c([^\u300c\u300d]*)\u300d$/, '$1'); // whisper may wrap a Japanese sentence in corner brackets
  const others = roster.live().filter((s) => !inMeeting(s.name));
  for (const name of findInvites({ text, live: others, inviteWords: CONFIG.inviteWords || [], sessionReadings: CONFIG.sessionReadings || {} })) {
    if (roster.join(name)) meeting.append(entry({ kind: 'join', from: name, text: UI.joined }));
  }
  const before = new Set(focus);
  const usedAside = aside;
  const r = resolve({
    text, participants: roster.participants(), focus, chairName: chairName(),
    everyoneWords: CONFIG.everyoneWords || [], sessionReadings: CONFIG.sessionReadings || {}, aside,
  });
  aside = null;
  focus = r.focus;
  const u = meeting.append(entry({ kind, from: 'human', to: r.to, maybe: r.maybe, aside: !!usedAside, text }));
  for (const name of r.to) if (!before.has(name) || name === usedAside) emit('signal', { name, kind: 'called' });
  emit('roster', rosterPayload());
  const sent = await courier.deliver(meeting, roster, u, r.to);
  for (const name of sent) awaiting.set(name, { since: u.id, sawBusy: false });
}

// ---- Share: every SHARE_MS, new utterances go to participants not in focus ----
setInterval(async () => {
  if (!meeting || meeting.info().state !== 'open' || Date.now() - lastShareAt < SHARE_MS) return;
  const fresh = meeting.list.filter((u) => ['voice', 'text', 'say'].includes(u.kind) && Date.parse(u.at) > lastShareAt);
  if (!fresh.length) return;
  lastShareAt = Date.now();
  const names = roster.participants().filter((p) => !focus.includes(p.name) && p.status !== 'absent').map((p) => p.name);
  if (!names.length) return;
  const sent = await courier.share(meeting, roster, names);
  if (!sent.length) return;
  const digest = fresh.slice(-10).map((u) => `${u.from === 'human' ? OWNER : labelOf(u.from)}: ${u.text}`).join(' / ');
  meeting.append(entry({ kind: 'share', from: 'system', to: sent, text: digest }));
  for (const name of sent) emit('signal', { name, kind: 'shared' });
}, 10000).unref();

// ---- Speech output ----
speech.on('audio', (m) => {
  const u = meeting.list.find((x) => x.id === m.id);
  if (u && (u.play === 'queued' || u.play === 'playing')) emit('audio', { id: m.id, seq: m.seq, url: '/audio/' + m.file, gap: m.gap, last: m.last, from: u.from });
});
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

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
  'POST /api/talk': async (req, res) => {
    const r = await speech.transcribe(await read(req, speech.maxAudio));
    if (r.error) { emit('note', { text: r.error }); return sendRes(res, 200, { error: r.error }); }
    const text = (r.text || '').trim();
    if (!text) { emit('note', { text: UI.unheard }); return sendRes(res, 200, { text: '' }); }
    sendRes(res, 200, { text, ms: r.ms });
    await human('voice', text);
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
    ok(res);
  },
  // Z-targeting: toggle one participant in the focus set
  'POST /api/focus': async (req, res) => {
    const { name } = await json(req);
    if (inMeeting(name)) focus = focus.includes(name) ? focus.filter((n) => n !== name) : [...focus, name];
    emit('roster', rosterPayload());
    ok(res);
  },
  // One-shot aside for the next human utterance; focus stays as it is
  'POST /api/aside': async (req, res) => {
    const { name } = await json(req);
    if (inMeeting(name)) aside = aside === name ? null : name;
    emit('roster', rosterPayload());
    ok(res);
  },
  'GET /api/live': async (req, res) => sendRes(res, 200, roster.live().filter((s) => !inMeeting(s.name))),
  'POST /api/invite': async (req, res) => {
    const { name } = await json(req);
    const p = inMeeting(name) ? null : roster.join(name);
    ok(res);
    if (p) {
      meeting.append(entry({ kind: 'join', from: name, text: UI.joined }));
      emit('roster', rosterPayload());
      await courier.greet(meeting, roster, p);
    }
  },
  'POST /api/dismiss': async (req, res) => {
    const { name } = await json(req);
    const p = roster.byName(name);
    ok(res);
    if (p && inMeeting(name)) {
      roster.leave(name);
      focus = focus.filter((n) => n !== name);
      if (aside === name) aside = null;
      awaiting.delete(name);
      meeting.append(entry({ kind: 'leave', from: name, text: UI.left }));
      emit('roster', rosterPayload());
      await courier.dismiss(meeting, p);
    }
  },
  'POST /api/leave': async (req, res) => { if (meeting.info().state === 'open') meeting.leave(GRACE_MS); ok(res); },
  'POST /api/back': async (req, res) => { if (meeting.info().state === 'leaving') meeting.back(); ok(res); },
  'POST /api/taste': async (req, res) => {
    const { name, taste } = await json(req);
    if (TASTES.includes(taste)) {
      if (name === '*') { prefs.defaultTaste = taste; prefs.tastes = {}; } else prefs.tastes[name] = taste;
      savePrefs();
      emit('roster', rosterPayload());
    }
    ok(res);
  },
  // From an AI pane (meet-say): speak it in the meeting
  'POST /api/say': async (req, res) => {
    const { pane, text, pass } = await json(req);
    const p = roster.byPane(pane);
    if (!p || !inMeeting(p.name) || meeting.info().state === 'closed') return sendRes(res, 403, 'this pane is not a participant of the meeting', 'text/plain; charset=utf-8');
    const t = String(text || '').trim();
    if (!t) return sendRes(res, 400, 'nothing to say', 'text/plain; charset=utf-8');
    awaiting.delete(p.name);
    const u = meeting.append(entry({ kind: 'say', from: p.name, text: t, play: 'queued' }));
    if (pass && p.chair && inMeeting(pass)) { focus = [pass]; emit('roster', rosterPayload()); }
    speech.speak(u.id, t, p.voice, p.style);
    sendRes(res, 200, { note: `spoken in the meeting (utterance ${u.id})` });
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
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
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
