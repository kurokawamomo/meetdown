// Thoughts: reads what each watched Claude Code session is doing from its transcript tail and
// emits it as a one-line "thought" for the participant's tile.
//   session file : <sessionsDir>/<pid>.json  { name, sessionId, cwd, status }
//   transcript   : <projectsDir>/<cwd with "/" and "." replaced by "-">/<sessionId>.jsonl
// Only the last TAIL_BYTES of the transcript are read. A thought is emitted only when it changes;
// when the transcript has not grown for idleMs the thought is cleared (text '').

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const TAIL_BYTES = 64 * 1024;
const MAX_LENGTH = 60;
const ELLIPSIS = String.fromCharCode(0x2026);

const clip = (s, n) => {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n - 1).join('') + ELLIPSIS : s;
};
const messageOf = (e) => (e && e.message) || String(e);

// The latest thing the session wrote in a chunk of transcript lines (tool calls are left out), or '' when there is none
export function latestActivity(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; } // a cut or damaged line
    if (!entry || entry.type !== 'assistant') continue;
    const content = entry.message && entry.message.content;
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b && b.type === 'text') {
        const first = String(b.text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        if (first) return clip(first, MAX_LENGTH);
      }
    }
  }
  return '';
}

async function readTail(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size, mtimeMs } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the first line is probably cut in half
    return { lines, mtimeMs };
  } finally {
    await handle.close();
  }
}

export function createThoughts({ sessionsDir, projectsDir, intervalMs = 3000, idleMs = 20000, log = () => {}, now = Date.now } = {}) {
  const emitter = new EventEmitter();
  let watched = [];
  let timer = null;
  let running = Promise.resolve();
  const last = new Map(); // name -> last emitted text

  async function sessionsByName() {
    const map = new Map();
    let files = [];
    try { files = await fs.readdir(sessionsDir); } catch (_) { return map; }
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const s = JSON.parse(await fs.readFile(path.join(sessionsDir, f), 'utf8'));
        if (s && s.name && s.sessionId && s.cwd) map.set(s.name, s);
      } catch (_) { /* a half-written session file */ }
    }
    return map;
  }

  async function textFor(session) {
    const dir = String(session.cwd).replace(/[/.]/g, '-');
    try {
      const { lines, mtimeMs } = await readTail(path.join(projectsDir, dir, `${session.sessionId}.jsonl`));
      if (now() - mtimeMs > idleMs) return '';
      return latestActivity(lines);
    } catch (_) {
      return '';
    }
  }

  async function pass() {
    try {
      const sessions = await sessionsByName();
      for (const name of watched) {
        const session = sessions.get(name);
        const text = session ? await textFor(session) : '';
        if (text === (last.get(name) ?? '')) continue;
        last.set(name, text);
        try { emitter.emit('thought', { name, text }); } catch (e) { log('thoughts', 'listener failed', messageOf(e)); }
      }
    } catch (e) {
      log('thoughts', 'tick failed', messageOf(e));
    }
  }

  // One pass over the watched names; passes run one after another. Never rejects.
  const tick = () => (running = running.then(pass));

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Sets the names to follow. A name that is no longer followed is forgotten, so a rejoin emits again.
  function watch(names) {
    watched = [...new Set(names || [])];
    for (const n of [...last.keys()]) if (!watched.includes(n)) last.delete(n);
    if (!watched.length) return stop();
    if (!timer) {
      timer = setInterval(tick, intervalMs);
      timer.unref();
    }
    tick();
  }

  return Object.assign(emitter, { watch, tick, stop });
}
