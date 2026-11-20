// Meeting: the utterance log of one meeting and its life cycle: open -> leaving -> closing -> closed.
// The log is an append-only JSONL file, <dir>/<id>.jsonl: one line per utterance, and {"update": id, ...} lines for later
// changes to an utterance (play state and the like). close() also writes <dir>/<id>.summary.md.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATES = Object.freeze(['open', 'leaving', 'closing', 'closed']);
export const DEFAULT_GRACE_MS = 10_000;

const CHAT_KINDS = new Set(['voice', 'text', 'say']);
const RESERVED = new Set(['id', 'at', 'update']); // update() never changes these
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// YYYY-MM-DD-xxxx: the local date, so the file name matches the calendar day of the person in the meeting
function freeId(dir, started, suffix) {
  for (let i = 0; i < 100; i++) {
    const id = `${localDate(started)}-${suffix()}`;
    if (!fs.existsSync(path.join(dir, `${id}.jsonl`)) && !fs.existsSync(path.join(dir, `${id}.summary.md`))) return id;
  }
  throw new Error('Meeting: no free meeting id');
}

export class Meeting extends EventEmitter {
  #now;
  #setTimer;
  #clearTimer;
  #labelOf;
  #log;
  #id;
  #startedAt;
  #logFile;
  #summaryFile;
  #state = 'open';
  #deadline = null;
  #timer = null;
  #summaryPath = null;
  #list = [];
  #byId = new Map();
  #lastId = 0;

  // now: () => Date. setTimer(fn, ms) -> handle and clearTimer(handle): replace them to control time in tests.
  // labelOf(name) -> display name, used in the summary file. log(...) receives write failures and listener errors from timers.
  constructor({
    dir,
    now = () => new Date(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    randomSuffix = () => crypto.randomBytes(2).toString('hex'),
    labelOf = (name) => name,
    log = () => {},
  } = {}) {
    super();
    if (typeof dir !== 'string' || !dir) throw new TypeError('Meeting: dir is required');
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#labelOf = labelOf;
    this.#log = log;
    const root = path.resolve(dir);
    fs.mkdirSync(root, { recursive: true });
    const started = this.#clock();
    this.#startedAt = started.toISOString();
    this.#id = freeId(root, started, randomSuffix);
    this.#logFile = path.join(root, `${this.#id}.jsonl`);
    this.#summaryFile = path.join(root, `${this.#id}.summary.md`);
  }

  get id() {
    return this.#id;
  }

  get state() {
    return this.#state;
  }

  // The utterances so far, in order. The live array: read it, do not change it.
  get list() {
    return this.#list;
  }

  get paths() {
    return { log: this.#logFile, summary: this.#summaryFile };
  }

  info() {
    return { id: this.#id, state: this.#state, startedAt: this.#startedAt, deadline: this.#deadline };
  }

  // Gives u its id (1, 2, 3 ... per meeting) and time, fills in empty fields, writes it to the log and announces it.
  // u itself is stored and returned, so later update() calls can use it. Appending is allowed in every state.
  append(u) {
    if (!u || typeof u !== 'object') throw new TypeError('Meeting.append: an utterance object is required');
    u.id = ++this.#lastId;
    u.at = this.#iso();
    u.to ??= [];
    u.maybe ??= [];
    u.aside ??= false;
    u.text ??= '';
    this.#list.push(u);
    this.#byId.set(u.id, u);
    const { id, at, ...rest } = u;
    this.#appendLine({ id, at, ...rest });
    this.emit('utterance', u);
    return u;
  }

  // target: an utterance of this meeting or its id. Writes {update: id, at, ...fields} and announces the utterance again.
  // Returns the utterance, or null when it does not belong to this meeting (a late event from an earlier meeting).
  update(target, fields) {
    const u = this.#byId.get(typeof target === 'number' ? target : target?.id);
    if (!u || (typeof target !== 'number' && u !== target)) return null;
    const changes = {};
    for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined && !RESERVED.has(key)) changes[key] = value;
    if (!Object.keys(changes).length) return u;
    Object.assign(u, changes);
    this.#appendLine({ update: u.id, at: this.#iso(), ...changes });
    this.emit('utterance', u);
    return u;
  }

  // The leave button: 'leaving' for graceMs, then 'expire'. Ignored unless the meeting is open (a second press keeps the first deadline).
  leave(graceMs = DEFAULT_GRACE_MS) {
    if (this.#state !== 'open') return false;
    const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : DEFAULT_GRACE_MS;
    this.#deadline = new Date(this.#clock().getTime() + grace).toISOString();
    this.#state = 'leaving';
    this.#timer = this.#setTimer(() => this.#expire(), grace);
    this.emit('state', this.info());
    return true;
  }

  // The back button: cancels leaving. False when the meeting is not leaving (too late, or never was).
  back() {
    if (this.#state !== 'leaving') return false;
    this.#enter('open');
    this.emit('state', this.info());
    return true;
  }

  // Writes <id>.summary.md (the summary text, then one plain line per utterance) and closes the meeting.
  // Allowed from any state; the second call changes nothing. Returns the file path, or null when it could not be written.
  close(summaryText) {
    if (this.#summaryPath) return this.#summaryPath;
    this.#summaryPath = this.#writeSummary(summaryText);
    if (this.#state !== 'closed') {
      this.#enter('closed');
      this.emit('state', this.info());
    }
    return this.#summaryPath;
  }

  // Returns whether the state changed. 'closed' is final. 'leaving' is leave() with the default grace.
  setState(state) {
    if (!STATES.includes(state)) throw new RangeError(`Meeting: unknown state ${state}`);
    if (state === 'leaving') return this.leave();
    if (this.#state === 'closed' || this.#state === state) return false;
    this.#enter(state);
    this.emit('state', this.info());
    return true;
  }

  // The grace is over. Listeners of 'expire' start the summary; if none moved the meeting on, closing starts now.
  // This runs from a timer, so a failing listener is logged instead of thrown.
  #expire() {
    this.#timer = null;
    if (this.#state !== 'leaving') return;
    this.#emitSafely('expire');
    if (this.#state === 'leaving') {
      this.#enter('closing');
      this.#emitSafely('state');
    }
  }

  #emitSafely(event) {
    try {
      this.emit(event, this.info());
    } catch (e) {
      this.#log(`meeting ${event} listener failed:`, e.message);
    }
  }

  #enter(state) {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#deadline = null;
    this.#state = state;
  }

  #clock() {
    return new Date(this.#now());
  }

  #iso() {
    return this.#clock().toISOString();
  }

  #appendLine(record) {
    try {
      fs.appendFileSync(this.#logFile, JSON.stringify(record) + '\n');
    } catch (e) {
      this.#log('meeting log write failed:', e.message); // the meeting goes on in memory
    }
  }

  #writeSummary(text) {
    try {
      fs.writeFileSync(this.#summaryFile, this.#render(text), 'utf8');
      return this.#summaryFile;
    } catch (e) {
      this.#log('meeting summary write failed:', e.message);
      return null;
    }
  }

  #label(name) {
    try {
      return String(this.#labelOf(name) ?? name);
    } catch (_) {
      return String(name);
    }
  }

  // The summary is already at the top, so the 'summary' utterance is not listed again
  #render(text) {
    const summary = typeof text === 'string' ? text.trim() : '';
    const shown = this.#list.filter((u) => u.kind !== 'summary');
    return [
      `# Meeting ${this.#id}`,
      '',
      `- Started: ${this.#startedAt}`,
      `- Ended: ${this.#iso()}`,
      `- Utterances: ${shown.length}`,
      '',
      '## Summary',
      '',
      summary || '_No summary was produced._',
      '',
      '## Utterances',
      '',
      ...(shown.length ? shown.map((u) => this.#line(u)) : ['_No utterances._']),
      '',
    ].join('\n');
  }

  // - 09:30:05 Owner -> Labs-01 (aside): text      (kinds other than voice, text and say get a [kind] tag)
  #line(u) {
    const tag = CHAT_KINDS.has(u.kind) ? '' : `[${u.kind}] `;
    const to = Array.isArray(u.to) && u.to.length ? ` -> ${u.to.map((n) => this.#label(n)).join(', ')}` : '';
    const head = `- ${localTime(new Date(u.at))} ${tag}${this.#label(u.from)}${to}${u.aside ? ' (aside)' : ''}:`;
    return `${head} ${oneLine(u.text)}`.trimEnd();
  }
}
