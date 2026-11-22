// Roster: which Claude Code sessions are alive (sessions directory + tmux) and which of them joined the meeting.
// poll() re-reads the live sessions; participants are the sessions that joined, in join order, and survive their
// session (status 'absent'). 'change' is emitted only when something visible changed.
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CHAIR = 'foxhound';
export const DEFAULT_TASTE = 'pixel';
// One call per poll returns the address and the title of every pane
export const LIST_PANES_ARGS = Object.freeze(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_title}']);

const runTmux = (args) => execFileSync('tmux', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });

// kill(0) and kill(-1) signal whole process groups and always succeed, so only positive integers are probed.
// EPERM means the process exists but belongs to someone else.
export function isAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

// FNV-1a, 32 bit, over the UTF-8 bytes: a hash that stays the same across runs, so a name keeps its voice
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(String(text), 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Claude Code puts a status glyph in front of the pane title ("<glyph> Name"). The glyph is stripped. A title without
// one was written by something else (shell hostname, an editor that exited), so it is no use as a name: ''.
export function cleanTitle(raw) {
  const text = String(raw ?? '').trim();
  const name = text.replace(/^[^\p{L}\p{N}]+/u, '');
  return name.length < text.length ? name.trim() : '';
}

// Output of LIST_PANES_ARGS -> Map(pane id -> { address, title }). Lines that do not parse are ignored.
export function parsePanes(output) {
  const panes = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const [id, session, win, pane, ...title] = line.replace(/\r$/, '').split('\t');
    if (!/^%\d+$/.test(id) || !session || !/^\d+$/.test(win ?? '') || !/^\d+$/.test(pane ?? '')) continue;
    panes.set(id, { address: { session, window: Number(win), pane: Number(pane) }, title: cleanTitle(title.join('\t')) });
  }
  return panes;
}

// A Participant without the fields that only the server uses (cursor, noticed)
export function publicParticipant(p) {
  const { cursor, noticed, ...rest } = p;
  return structuredClone(rest);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byLayout = (a, b) => cmp(a.address.session, b.address.session) || a.address.window - b.address.window || a.address.pane - b.address.pane || cmp(a.name, b.name);
const nonEmpty = (v) => typeof v === 'string' && v !== '';
const paneIdOf = (tmuxField) => (/(%\d+)\s*$/.exec(String(tmuxField)) || [])[1] || null; // "labs:@0.%4" -> "%4" (@0 is a window id, not an index)
const startedAtMs = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);
const statusOf = (d) => (nonEmpty(d.status) ? d.status : 'idle');
const newer = (a, b) => {
  const [x, y] = [startedAtMs(a.startedAt), startedAtMs(b.startedAt)];
  return x > y || (x === y && a.pid > b.pid);
};

export class Roster extends EventEmitter {
  #dir;
  #people;
  #pool;
  #taste;
  #tmux;
  #chair;
  #live = new Map(); // name -> LiveSession, newest session per name
  #members = []; // Participant[] in join order
  #parsed = new Map(); // session file -> last good parse, so a half-written file does not make a session blink away
  #polled = false;
  #liveSig = '[]';
  #memberSig = '[]';

  // people: config.people, keyed by session name. voicePool: [{ voice, style }]. tmux: (args) => stdout string.
  constructor({ sessionsDir, people, voicePool, defaultTaste, tmux, defaultChair } = {}) {
    super();
    if (!nonEmpty(sessionsDir)) throw new TypeError('Roster: sessionsDir is required');
    this.#dir = sessionsDir;
    this.#people = people && typeof people === 'object' ? people : {};
    this.#pool = Array.isArray(voicePool) ? voicePool : [];
    this.#taste = defaultTaste || DEFAULT_TASTE;
    this.#tmux = typeof tmux === 'function' ? tmux : runTmux;
    this.#chair = nonEmpty(defaultChair) ? defaultChair : DEFAULT_CHAIR;
  }

  // Re-read sessions and tmux, refresh the participants, emit 'change' ({ live, participants }) if anything changed.
  // Returns whether it changed.
  poll() {
    this.#polled = true;
    const candidates = this.#readSessions();
    const panes = candidates.size ? this.#readPanes() : new Map();
    const live = new Map();
    for (const [name, d] of candidates) {
      const pane = paneIdOf(d.tmux);
      if (!pane) continue;
      const where = panes ? panes.get(pane) : this.#remembered(name, pane);
      if (!where) continue; // the pane is not in tmux: the session cannot be reached
      live.set(name, { name, pane, address: where.address, title: where.title, status: statusOf(d) });
    }
    this.#live = live;
    for (const p of this.#members) {
      const s = live.get(p.name);
      if (s) this.#apply(p, s);
      else {
        p.status = 'absent';
        p.pane = null; // nothing to deliver to; address and title stay as they were
      }
    }
    return this.#commit();
  }

  // Every live session, joined or not, in tmux order. The first call polls if poll() has never run.
  live() {
    this.#ensurePolled();
    return this.#liveList();
  }

  // The participants of the meeting, in join order. These are the live objects: the courier moves cursor and noticed on them.
  participants() {
    return [...this.#members];
  }

  join(name) {
    this.#ensurePolled();
    const existing = this.byName(name);
    if (existing) return existing;
    const s = this.#live.get(name);
    if (!s) return null;
    const p = this.#create(s);
    this.#members.push(p);
    this.#commit();
    return p;
  }

  leave(name) {
    const i = this.#members.findIndex((p) => p.name === name);
    if (i < 0) return false;
    this.#members.splice(i, 1);
    this.#commit();
    return true;
  }

  byName(name) {
    return this.#members.find((p) => p.name === name) ?? null;
  }

  // An absent participant has no pane, so it never matches
  byPane(paneId) {
    return paneId ? (this.#members.find((p) => p.pane === paneId) ?? null) : null;
  }

  // New meeting: everybody leaves, then the names in autoJoin join if they are live. Returns the new participants.
  reset(autoJoin = []) {
    this.#ensurePolled();
    this.#members = [];
    for (const name of autoJoin ?? []) {
      const s = this.#live.get(name);
      if (s && !this.byName(name)) this.#members.push(this.#create(s));
    }
    this.#commit();
    return this.participants();
  }

  #ensurePolled() {
    if (!this.#polled) this.poll();
  }

  #liveList() {
    return [...this.#live.values()].map((s) => ({ ...s, address: { ...s.address } })).sort(byLayout);
  }

  #commit() {
    const liveSig = JSON.stringify(this.#liveList());
    const memberSig = JSON.stringify(this.#members.map(publicParticipant));
    const live = liveSig !== this.#liveSig;
    const participants = memberSig !== this.#memberSig;
    this.#liveSig = liveSig;
    this.#memberSig = memberSig;
    if (live || participants) this.emit('change', { live, participants });
    return live || participants;
  }

  // Sessions that count: interactive, inside tmux, pid alive. The newest startedAt wins per name.
  // The filters run before the per-name choice, so a background session with the same name cannot shadow a live one.
  #readSessions() {
    let files = [];
    try {
      files = fs.readdirSync(this.#dir).filter((f) => f.endsWith('.json')).sort();
    } catch (_) {
      // no sessions directory: nobody is live
    }
    const listed = new Set(files);
    for (const f of this.#parsed.keys()) if (!listed.has(f)) this.#parsed.delete(f);
    const newest = new Map();
    for (const file of files) {
      const d = this.#readFile(file);
      if (!d || d.kind !== 'interactive' || !nonEmpty(d.name) || !nonEmpty(d.tmux) || !isAlive(d.pid)) continue;
      const prev = newest.get(d.name);
      if (!prev || newer(d, prev)) newest.set(d.name, d);
    }
    return newest;
  }

  #readFile(file) {
    let text;
    try {
      text = fs.readFileSync(path.join(this.#dir, file), 'utf8');
    } catch (_) {
      this.#parsed.delete(file);
      return null;
    }
    try {
      const d = JSON.parse(text);
      if (d && typeof d === 'object') {
        this.#parsed.set(file, d);
        return d;
      }
      this.#parsed.delete(file);
      return null;
    } catch (_) {
      return this.#parsed.get(file) ?? null; // caught while being written: use the last good copy
    }
  }

  // null when tmux cannot be asked (no server, timeout) or its answer has no readable pane
  #readPanes() {
    try {
      const panes = parsePanes(this.#tmux([...LIST_PANES_ARGS]));
      return panes.size ? panes : null;
    } catch (_) {
      return null;
    }
  }

  // With tmux unreachable, a session that stays in the same pane keeps the address and title it had
  #remembered(name, pane) {
    const prev = this.#live.get(name);
    return prev && prev.pane === pane ? prev : null;
  }

  #cfgOf(name) {
    const cfg = Object.hasOwn(this.#people, name) ? this.#people[name] : null;
    return cfg && typeof cfg === 'object' ? cfg : {};
  }

  #create(s) {
    const cfg = this.#cfgOf(s.name);
    const { voice, style } = cfg.voice ? { voice: cfg.voice, style: cfg.style ?? '' } : this.#pick(s.name);
    const p = {
      name: s.name,
      aliases: Array.isArray(cfg.aliases) ? cfg.aliases.filter(nonEmpty) : [],
      voice, style,
      chair: this.#isChair(s.name, cfg),
      taste: cfg.taste || this.#taste,
      look: cfg.look && typeof cfg.look === 'object' ? { ...cfg.look } : {},
      cursor: 0, noticed: 0,
    };
    this.#apply(p, s); // pane, address, title, status, label
    return p;
  }

  // The fields that follow the live session. The label is the configured one, else the pane title, else the name.
  #apply(p, s) {
    p.pane = s.pane;
    p.address = { ...s.address };
    p.title = s.title;
    p.status = s.status;
    p.label = this.#cfgOf(p.name).label || s.title || p.name;
  }

  #pick(name) {
    if (!this.#pool.length) return { voice: '', style: '' };
    const entry = this.#pool[fnv1a(name) % this.#pool.length];
    return { voice: entry?.voice ?? '', style: entry?.style ?? '' };
  }

  // An explicit flag in the config wins. Without any flag in the config, the default chair is the chair.
  #isChair(name, cfg) {
    if (typeof cfg.chair === 'boolean') return cfg.chair;
    const flagged = Object.values(this.#people).some((v) => v && v.chair === true);
    return !flagged && name === this.#chair;
  }
}
