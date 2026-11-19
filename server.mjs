// meetdown server. The center of a meeting is the utterance log; transcription, delivery to panes,
// speech synthesis and page updates all read from or append to it.
// Listens on 127.0.0.1 only and answers nothing without the token.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const OWNER = CONFIG.owner || 'the user';
const DRY = CONFIG.dryDeliver || process.env.MEETDOWN_DRY === '1'; // for testing: log deliveries instead of sending them
const UI = {
  you: 'You', meeting: 'Meeting', talk: 'Hold to talk', placeholder: 'Type a message', send: 'Send',
  idle: 'idle', busy: 'working', absent: 'away', cut: 'cut off', dropped: 'not played', error: 'no voice',
  transcribing: 'Transcribing...', unheard: 'Could not catch that', micError: 'Microphone unavailable: ',
  sendError: 'Could not send: ', reconnecting: 'Disconnected. Reconnecting...',
  paneMissing: 'Could not find the pane of {name}', gaveUp: 'Could not deliver to {name} ({why})',
  ...(CONFIG.ui || {}),
};
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const EVERYONE = (CONFIG.everyoneWords || ['everyone']).map((w) => w.toLowerCase());
const PLUGINS = path.join(os.homedir(), '.claude/plugins/marketplaces/plugin-marketplace/plugins');
const STATE = path.join(ROOT, 'state');
const AUDIO = path.join(STATE, 'audio');
const SAY = path.join(ROOT, 'bin/meet-say').replace(os.homedir(), '~');
fs.rmSync(AUDIO, { recursive: true, force: true }); // utterance ids restart at 1 in every meeting
fs.mkdirSync(AUDIO, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'meetings'), { recursive: true });

// Existing parts, used as they are: transcription from qd, delivery to panes from tmux-foxhound
const { Voice, MAX_AUDIO } = createRequire(import.meta.url)(path.join(PLUGINS, 'question-dashboard/skills/qd/scripts/voice.js'));
const { sendToPane } = await import(pathToFileURL(path.join(PLUGINS, 'tmux-foxhound/skills/tmux-foxhound/scripts/foxhound-pane.mjs')).href);
const voice = new Voice(STATE); // its own state dir: Voice kills a leftover whisper-server found in the dir it is given

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

// ---- Utterance log ----
const meetingId = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(2).toString('hex');
const LOG = path.join(ROOT, 'meetings', meetingId + '.jsonl');
const list = [];
let lastId = 0;
const participants = CONFIG.participants.map((p) => ({ ...p, cursor: 0, noticed: 0, status: 'absent', pane: null }));
let partner = null; // who an utterance without a name goes to
const byName = (n) => participants.find((p) => p.name === n);
const labelOf = (n) => (n === 'human' ? OWNER : n === 'system' ? UI.meeting : (byName(n) || {}).label || n);
const clip = (s, n) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s);

function append(u) {
  u.id = ++lastId;
  u.at = new Date().toISOString();
  list.push(u);
  fs.appendFileSync(LOG, JSON.stringify(u) + '\n');
  emit('utterance', u);
  return u;
}
function update(u, fields) {
  Object.assign(u, fields);
  fs.appendFileSync(LOG, JSON.stringify({ update: u.id, at: new Date().toISOString(), ...fields }) + '\n');
  emit('utterance', u);
}
const note = (text) => append({ kind: 'note', from: 'system', to: [], text });

// ---- Page updates (Server-Sent Events) ----
const clients = new Set();
function emit(type, data) {
  const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(s);
}
const roster = () => ({ partner, participants: participants.map(({ name, label, status, chair }) => ({ name, label, status, chair })) });
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000).unref();

// ---- Roster: pane and idle/busy of live sessions in ~/.claude/sessions ----
const SESSIONS = path.join(os.homedir(), '.claude/sessions');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function pollSessions() {
  const seen = new Map();
  for (const f of fs.readdirSync(SESSIONS).filter((x) => x.endsWith('.json'))) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')); } catch (_) { continue; }
    if (d.kind !== 'interactive' || !d.tmux || !alive(d.pid)) continue;
    const prev = seen.get(d.name);
    if (!prev || d.startedAt > prev.startedAt) seen.set(d.name, d);
  }
  let changed = false;
  for (const p of participants) {
    const d = seen.get(p.name);
    const status = d ? d.status || 'idle' : 'absent';
    const pane = d ? String(d.tmux).split('.').pop() : null;
    if (status !== p.status || pane !== p.pane) { p.status = status; p.pane = pane; changed = true; }
  }
  if (changed) emit('participants', roster());
}
pollSessions();
setInterval(pollSessions, 3000).unref();

// ---- Addressing: a name, then "everyone", then the current partner, then the chair ----
function pickTargets(text) {
  const t = text.toLowerCase();
  if (EVERYONE.some((w) => t.includes(w))) return participants.map((p) => p.name);
  const named = participants.filter((p) => [p.name, p.label, ...(p.aliases || [])].filter(Boolean).some((a) => t.includes(String(a).toLowerCase())));
  if (named.length) return named.map((p) => p.name);
  if (partner) return [partner];
  const chair = participants.find((p) => p.chair) || participants[0];
  return chair ? [chair.name] : [];
}

// ---- Delivery to a pane, with what was said since the participant last heard and how to reply ----
function deliver(name, u) {
  const p = byName(name);
  const digest = list
    .filter((x) => x.id > p.cursor && x.id !== u.id && x.from !== name && x.text && ['voice', 'text', 'say'].includes(x.kind))
    .slice(-10)
    .map((x) => `${labelOf(x.from)}: "${clip(x.text, 80)}"`)
    .join(' ');
  const mine = list.filter((x) => x.from === name && x.kind === 'say' && x.id > p.noticed && (x.play === 'cut' || x.play === 'dropped'));
  const cut = mine.length ? mine[mine.length - 1] : null;
  const cutNote = !cut ? '' : cut.play === 'cut' ? ` / Your previous remark was cut off during sentence ${cut.cutAt + 1}.` : ' / Your previous remark was not played.';
  p.cursor = u.id;
  p.noticed = lastId;
  const body = `[meetdown ${OWNER} (${u.kind === 'voice' ? 'voice' : 'text'})] ${u.text}` + (digest ? ` / Since you last heard: ${digest}` : '') + cutNote
    + ` (meeting ${meetingId}; you are ${p.label || name}. Reply by running ${SAY} "what to say": spoken style, 1-3 sentences, in the language of the message. Text-only replies are not heard in the meeting.)`;
  if (DRY) { log('dry-deliver', name, body); return; }
  if (!p.pane) { note(fill(UI.paneMissing, { name: p.label || name })); return; }
  sendToPane(p.pane, body, {
    log: (...a) => log('pane', ...a),
    tag: `u${u.id}`,
    onGiveup: (why) => note(fill(UI.gaveUp, { name: p.label || name, why })),
  }).catch((e) => log('deliver', e.message));
}

function human(kind, raw) {
  const text = raw.replace(/^\u300c([^\u300c\u300d]*)\u300d$/, '$1'); // whisper may wrap a Japanese sentence in corner brackets
  const to = pickTargets(text);
  if (to.length === 1) partner = to[0];
  const u = append({ kind, from: 'human', to, text });
  emit('participants', roster());
  for (const n of to) deliver(n, u);
}

// ---- Speech worker (tts_worker.py). Tells the page as each sentence's wav is ready ----
const synth = new Set(); // ids of utterances being synthesized
let worker = null;
function startWorker() {
  const py = path.join(os.homedir(), '.claude/skills/tts/.venv/bin/python');
  worker = spawn(py, [path.join(ROOT, 'tts_worker.py'), AUDIO], { stdio: ['pipe', 'pipe', 'pipe'] });
  worker.stderr.on('data', (b) => log('tts', String(b).trim()));
  readline.createInterface({ input: worker.stdout }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch (_) { return log('tts-out', line); }
    if (m.ready) return log('tts ready');
    const u = list.find((x) => x.id === m.id);
    if (m.file && u && (u.play === 'queued' || u.play === 'playing')) emit('audio', { id: m.id, seq: m.seq, url: '/audio/' + m.file, gap: m.gap, last: m.last, from: u.from });
    if (m.error) { log('tts error', m.id, m.error); if (u) update(u, { play: 'error' }); }
    if (m.done || m.error) synth.delete(m.id);
  });
  worker.on('exit', (code) => { log('tts exit', code); worker = null; setTimeout(startWorker, 3000).unref(); });
}
startWorker();
function speak(u, p) {
  synth.add(u.id);
  if (worker) worker.stdin.write(JSON.stringify({ id: u.id, text: u.text, voice: p.voice, style: p.style }) + '\n');
}

// ---- HTTP ----
const read = (req, limit) => new Promise((resolve, reject) => {
  const parts = [];
  let size = 0;
  req.on('data', (b) => { size += b.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(b); });
  req.on('end', () => resolve(Buffer.concat(parts)));
  req.on('error', reject);
});
const json = async (req) => JSON.parse(String(await read(req, 64 * 1024)) || '{}');
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const PAGE = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };

const routes = {
  // Pressed: start loading whisper, stop the voice being played and drop the rest
  'POST /api/press': async (req, res) => {
    const { playing, pending = [] } = await json(req);
    voice.start();
    const cut = playing && list.find((x) => x.id === playing.id);
    if (cut && cut.kind === 'say') update(cut, { play: 'cut', cutAt: playing.seq });
    const drop = new Set([...synth, ...pending.map(Number)]);
    if (cut) drop.delete(cut.id);
    if (worker && synth.size) worker.stdin.write(JSON.stringify({ cancel: [...synth] }) + '\n');
    for (const id of drop) {
      const u = list.find((x) => x.id === id);
      if (u && u.kind === 'say' && (u.play === 'queued' || u.play === 'playing')) update(u, { play: 'dropped' });
    }
    synth.clear();
    emit('stop', {});
    send(res, 200, { ok: true });
  },
  'POST /api/cancel': async (req, res) => { voice.cancel(); send(res, 200, { ok: true }); },
  // Released: transcribe the recording and deliver it
  'POST /api/talk': async (req, res) => {
    const r = await voice.transcribe(await read(req, MAX_AUDIO));
    if (r.error) { emit('note', { text: r.error }); return send(res, 200, { error: r.error }); }
    const text = (r.text || '').trim();
    if (!text) { emit('note', { text: UI.unheard }); return send(res, 200, { text: '' }); }
    human('voice', text);
    send(res, 200, { text, ms: r.ms });
  },
  'POST /api/text': async (req, res) => {
    const text = String((await json(req)).text || '').trim();
    if (text) human('text', text);
    send(res, 200, { ok: true });
  },
  // A participant was tapped on the page: make them the partner
  'POST /api/partner': async (req, res) => {
    const { name } = await json(req);
    if (byName(name)) partner = name;
    emit('participants', roster());
    send(res, 200, roster());
  },
  // The page started or finished playing an utterance
  'POST /api/play': async (req, res) => {
    const { id, state } = await json(req);
    const u = list.find((x) => x.id === id);
    const next = { queued: ['playing', 'done'], playing: ['done'] };
    if (u && (next[u.play] || []).includes(state)) update(u, { play: state });
    send(res, 200, { ok: true });
  },
  // From an AI pane (meet-say): speak it in the meeting
  'POST /api/say': async (req, res) => {
    const { pane, text, pass } = await json(req);
    const p = participants.find((x) => x.pane && x.pane === pane);
    if (!p) return send(res, 403, 'this pane is not a participant of the meeting', 'text/plain; charset=utf-8');
    const t = String(text || '').trim();
    if (!t) return send(res, 400, 'nothing to say', 'text/plain; charset=utf-8');
    const u = append({ kind: 'say', from: p.name, to: [], text: t, play: 'queued' });
    if (pass && p.chair && byName(pass)) { partner = pass; emit('participants', roster()); }
    speak(u, p);
    send(res, 200, { note: `spoken in the meeting (utterance ${u.id})` });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    // A URL with the token: move it into a cookie and drop it from the URL
    const t = url.searchParams.get('t');
    if (req.method === 'GET' && url.pathname === '/' && t) {
      if (!same(t)) return send(res, 403, 'forbidden', 'text/plain');
      res.writeHead(303, { 'Set-Cookie': `meetdown=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
      return res.end();
    }
    if (!same(cookieToken(req)) && !same(req.headers['x-token'])) return send(res, 403, 'forbidden', 'text/plain');

    if (req.method === 'GET' && PAGE[url.pathname]) {
      const [file, type] = PAGE[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'page', file)), type);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ meetingId, list, ui: UI, lang: CONFIG.lang || 'en', overlap: CONFIG.overlapSeconds ?? 1, ...roster() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const audio = url.pathname.match(/^\/audio\/(\d+-\d+\.wav)$/);
    if (req.method === 'GET' && audio) {
      const f = path.join(AUDIO, audio[1]);
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), 'audio/wav') : send(res, 404, 'not found', 'text/plain');
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res);
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    log('error', req.method, url.pathname, e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(CONFIG.port, '127.0.0.1', () => log(`listening 127.0.0.1:${CONFIG.port} meeting=${meetingId}${DRY ? ' (dry-deliver)' : ''}`));
const quit = () => { voice.shutdown(); if (worker) worker.kill(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
