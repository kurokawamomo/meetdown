// Speech: transcription of the human's recording (the qd Voice class, loaded from the installed plugin)
// and synthesis of the participants' remarks (tts_worker.py, kept running as a child process).
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOICE_IN_MARKETPLACE = 'plugins/question-dashboard/skills/qd/scripts/voice.js';
const DEFAULT_MAX_AUDIO = 30 * 1024 * 1024;
const RESTART_MS = 3000;
const AUDIO_KEEP_MS = 10 * 60 * 1000; // how long a sentence's wav stays on disk after its job ended
const WAV_NAME = /^\d+-\d+\.wav$/;

// The marketplace directory that holds the plugin is named by whoever installed it, so look in all of them
function findVoiceModule() {
  const root = path.join(os.homedir(), '.claude/plugins/marketplaces');
  let names = [];
  try { names = fs.readdirSync(root).sort(); } catch (_) { return null; }
  return names.map((n) => path.join(root, n, VOICE_IN_MARKETPLACE)).find((f) => fs.existsSync(f)) || null;
}

// -> EventEmitter: start, cancel, transcribe(buf), maxAudio, speak(id, text, voice, style), cancelSynth(ids), pending(), shutdown()
// Events: 'audio' {id, seq, file, gap, last}, 'done' {id}, 'error' {id, error}
// The worker's wav for one sentence is `file` inside audioDir. Its name is built from a job number, not from the utterance id.
export function createSpeech({ stateDir, audioDir, log = () => {}, voiceModule, python, workerScript } = {}) {
  const speech = new EventEmitter();

  // An 'error' event nobody listens for would throw inside the worker pipe, so then it is only logged
  const emit = (type, data) => {
    if (type === 'error' && speech.listenerCount('error') === 0) return log('speech', 'error', data.id, data.error);
    try { speech.emit(type, data); } catch (e) { log('speech', `a ${type} listener threw`, e.message); }
  };

  // ---- Transcription ----
  let transcriber = null;
  let transcriberError = '';
  speech.maxAudio = DEFAULT_MAX_AUDIO;
  try {
    const file = voiceModule || findVoiceModule();
    if (!file) throw new Error('the qd voice module was not found under ~/.claude/plugins/marketplaces');
    const mod = createRequire(import.meta.url)(file);
    fs.mkdirSync(stateDir, { recursive: true }); // Voice kills a leftover whisper-server it finds in this directory
    transcriber = new mod.Voice(stateDir);
    speech.maxAudio = mod.MAX_AUDIO || DEFAULT_MAX_AUDIO;
  } catch (e) {
    transcriberError = `Speech input is not available: ${e.message}`;
    log('speech', transcriberError);
  }

  speech.start = () => {
    if (!transcriber) return { ok: false, error: transcriberError };
    try { return transcriber.start(); } catch (e) { return { ok: false, error: e.message }; }
  };
  speech.cancel = () => {
    try { if (transcriber) transcriber.cancel(); } catch (e) { log('speech', 'cancel failed', e.message); }
  };
  speech.transcribe = async (buf) => {
    if (!transcriber) return { error: transcriberError, ms: 0 };
    try { return await transcriber.transcribe(buf); } catch (e) { return { error: e.message, ms: 0 }; }
  };

  // ---- Synthesis ----
  // Utterance ids restart in every meeting, but the worker remembers cancelled ids for good and names its files after
  // the id it is given. So the worker gets its own ever-increasing job numbers, and this module maps them back.
  const jobs = new Map(); // job number -> { id, files, silent }; silent = cancelled, nothing more is reported
  const pending = new Set(); // utterance ids still being synthesized and not cancelled
  let jobSerial = 0;
  let child = null;
  let stopped = false;
  let restartTimer = null;

  fs.mkdirSync(audioDir, { recursive: true });
  for (const f of fs.readdirSync(audioDir)) if (WAV_NAME.test(f)) fs.rmSync(path.join(audioDir, f), { force: true });

  function endJob(job) {
    const entry = jobs.get(job);
    if (!entry) return;
    jobs.delete(job);
    pending.delete(entry.id);
    if (!entry.files.length) return;
    // The page fetches a wav as soon as it hears of it, so the files can go a while after the job ended
    setTimeout(() => { for (const f of entry.files) fs.rm(path.join(audioDir, f), { force: true }, () => {}); }, AUDIO_KEEP_MS).unref();
  }

  function failAll(error) {
    for (const [job, entry] of [...jobs]) {
      endJob(job);
      if (!entry.silent) emit('error', { id: entry.id, error });
    }
  }

  function onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch (_) { return log('tts-out', line); }
    if (m.ready) return log('tts ready');
    const entry = jobs.get(m.id);
    if (!entry) return;
    if (m.file) {
      entry.files.push(m.file);
      if (!entry.silent) emit('audio', { id: entry.id, seq: m.seq, file: m.file, gap: m.gap, last: m.last, text: m.text || '' });
    }
    if (!m.error && !m.done) return;
    const { id, silent } = entry;
    endJob(m.id);
    if (m.error) {
      log('tts error', id, m.error);
      if (!silent) emit('error', { id, error: String(m.error) });
    } else if (!silent) {
      emit('done', { id });
    }
  }

  function scheduleRestart() {
    if (stopped) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startWorker, RESTART_MS);
    restartTimer.unref();
  }

  function startWorker() {
    if (stopped) return;
    const py = python || path.join(os.homedir(), '.claude/skills/tts/.venv/bin/python');
    const script = workerScript || path.join(HERE, '..', 'tts_worker.py');
    let proc;
    try {
      proc = spawn(py, [script, audioDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log('tts', 'could not start the worker', e.message);
      return scheduleRestart();
    }
    child = proc;
    proc.stderr.on('data', (b) => log('tts', String(b).trim()));
    proc.stdin.on('error', () => {}); // a dead worker closes the pipe; the exit handler does the clean-up
    readline.createInterface({ input: proc.stdout }).on('line', onLine);
    let ended = false;
    const onEnd = (why) => {
      if (ended) return;
      ended = true;
      if (child === proc) child = null;
      log('tts exit', why);
      failAll('the speech worker stopped');
      scheduleRestart();
    };
    proc.on('error', (e) => onEnd(`error ${e.message}`));
    proc.on('exit', (code, signal) => onEnd(`code ${code}${signal ? ` ${signal}` : ''}`));
  }
  startWorker();

  const writable = () => child && child.stdin.writable;

  speech.speak = (id, text, voice, style) => {
    if (!writable()) {
      log('speech', 'the worker is not running, dropped', id);
      setImmediate(() => emit('error', { id, error: 'the speech worker is not running' }));
      return;
    }
    const job = ++jobSerial;
    jobs.set(job, { id, files: [], silent: false });
    pending.add(id);
    child.stdin.write(JSON.stringify({ id: job, text, voice, style }) + '\n');
  };

  // Stops synthesizing these utterances; nothing is reported for them afterwards
  speech.cancelSynth = (ids) => {
    const want = new Set([...ids].map(Number));
    const cancel = [];
    for (const [job, entry] of jobs) {
      if (entry.silent || !want.has(Number(entry.id))) continue;
      entry.silent = true;
      pending.delete(entry.id);
      cancel.push(job);
    }
    if (cancel.length && writable()) child.stdin.write(JSON.stringify({ cancel }) + '\n');
  };

  speech.pending = () => new Set(pending);

  speech.shutdown = () => {
    stopped = true;
    clearTimeout(restartTimer);
    try { if (transcriber) transcriber.shutdown(); } catch (_) { /* leaving anyway */ }
    jobs.clear();
    pending.clear();
    if (child) child.kill();
    child = null;
  };

  return speech;
}
