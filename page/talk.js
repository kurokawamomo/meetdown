// Push-to-talk and tap-to-toggle recording, from a button and from the Space key.
//   press down            -> onPress() at once (barge-in) and recording starts
//   released before holdMs -> 'toggled': keep recording; the next tap (down and up) stops and sends
//   released after holdMs  -> stop and send
// While recording, every `interimSeconds` the recorder is stopped and restarted, so each blob is a
// self-contained file; onSend(blob, mime, { turn, part, final }) is called for every part. The input level
// (onLevel, 0..1) and pauses in speech (onPause(bool): quiet for PAUSE_MS) come from an analyser on the stream.
// Beyond the contract: the `unlock` option (called on every gesture, so the page can unlock audio), the
// `enabled` option (a press that would start a recording is ignored while it returns false), `holdMs` may
// be a function, onChange(fn) receives (state, error), and closeMic() releases the microphone.
// Hands-free: a recording opened by a tap (not by holding) does not close the microphone when it is sent. The state
// becomes 'listening': the microphone stays open and waits for the human to speak again. A loud level that lasts
// (startLevel for startMs; higher while the AI voice is playing, so its own echo does not count) starts a recording,
// cuts the AI voice (onPress), and when the human has been quiet for quietSeconds the recording is sent with
// `min`: the server drops it when the transcript is shorter than minChars. A tap while listening closes the microphone.

const DEFAULT_HOLD_MS = 300;
const TICK_MS = 50;
const DEFAULT_INTERIM_SECONDS = 15;
const PAUSE_THRESHOLD = 0.02; // RMS (0..1) below which the input counts as quiet
const PAUSE_MS = 800;
const LEVEL_GAIN = 4; // speech RMS is small; the level shown to the bar is RMS times this, capped at 1
const START_GAP_MS = 200; // a loud run survives a dip this short (speech has gaps between syllables)
// Levels are on the meter's scale (RMS times LEVEL_GAIN, 0..1); the numbers are config.json's `handsFree`
export const HANDS_FREE_DEFAULTS = { enabled: true, startLevel: 0.35, startMs: 400, speakingLevel: 0.6, speakingMs: 600, minChars: 4, quietSeconds: 1, maxSeconds: 30 };
const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

const call = (fn, ...args) => {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (e) { console.error(e); }
};

// Root mean square of audio samples (-1..1), 0 for none
export function rmsOf(samples) {
  const n = samples ? samples.length : 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

// True when the current segment has run for the whole interval and the recorder must be restarted
export function segmentDue({ startedAt, now, intervalMs }) {
  return Number.isFinite(intervalMs) && intervalMs > 0 && now - startedAt >= intervalMs;
}

// True when the human has talked long enough and then stayed quiet long enough: the turn ends by itself
export function turnOver({ startedAt, quietSince, now, afterMs, quietMs }) {
  if (!(afterMs > 0) || !(quietMs > 0) || quietSince == null) return false;
  return now - startedAt >= afterMs && now - quietSince >= quietMs;
}

// Quiet for holdMs in a row = paused. feed(level, t) returns the paused flag; a level at or above the threshold ends it at once.
export function createPauseDetector({ threshold = PAUSE_THRESHOLD, holdMs = PAUSE_MS } = {}) {
  let quietSince = null;
  let paused = false;
  return {
    feed(level, t) {
      if (level >= threshold) { quietSince = null; paused = false; return false; }
      if (quietSince === null) quietSince = t;
      if (t - quietSince >= holdMs) paused = true;
      return paused;
    },
    reset() { quietSince = null; paused = false; },
    get paused() { return paused; },
  };
}

// Did the human start speaking? A level at or above `threshold` begins a run; dips shorter than gapMs do not end it.
// feed(level, t, { threshold, ms }) -> 'none' (no run) | 'maybe' (a run, not yet ms long) | 'speech' (a run of ms)
export function createStartDetector({ gapMs = START_GAP_MS } = {}) {
  let since = null;
  let lastLoud = null;
  return {
    feed(level, t, { threshold, ms }) {
      if (level >= threshold) {
        if (since === null) since = t;
        lastLoud = t;
      } else if (since !== null && t - lastLoud > gapMs) {
        since = null;
        lastLoud = null;
      }
      if (since === null) return 'none';
      return t - since >= ms ? 'speech' : 'maybe';
    },
    reset() { since = null; lastLoud = null; },
  };
}

// The listening-state recording ends when the human was quiet for quietMs after speaking, or it ran maxMs
export function listenOver({ startedAt, quietSince, now, quietMs, maxMs }) {
  if (maxMs > 0 && now - startedAt >= maxMs) return true;
  return quietMs > 0 && quietSince != null && now - quietSince >= quietMs;
}

// The timing rules, free of the DOM and the microphone so they can be tested.
// effects: { press(), start(), stop(send), listen(), unlisten() }. States: 'idle' | 'holding' | 'toggled' | 'listening'.
// handsFree(): true when a tap-toggled recording goes on to 'listening' instead of 'idle'.
export function createTalkMachine({ holdMs = DEFAULT_HOLD_MS, now = () => Date.now(), effects = {}, onChange = () => {}, enabled = () => true, handsFree = () => false } = {}) {
  let state = 'idle';
  let error = null;
  let downAt = 0;
  let source = null; // the input that is down right now: 'key' | 'pointer'
  let stopTap = false; // toggled or listening: the tap that will stop the recording (or close the microphone) is down

  const limit = () => {
    const v = Number(typeof holdMs === 'function' ? holdMs() : holdMs);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_HOLD_MS;
  };
  const set = (next, err = null) => {
    state = next;
    error = err;
    onChange(state, error);
  };

  function down(from = 'pointer') {
    if (source !== null) return; // another input is already down
    if (state === 'idle') {
      if (!enabled()) return;
      source = from;
      downAt = now();
      set('holding');
      call(effects.press);
      call(effects.start);
    } else if (state === 'toggled' || state === 'listening') {
      source = from;
      stopTap = true;
    }
  }

  // A tap-toggled recording is over and sent: keep listening, or go idle
  function sent() {
    if (handsFree()) {
      set('listening');
      call(effects.stop, true);
      call(effects.listen);
    } else {
      set('idle');
      call(effects.stop, true);
    }
  }

  function up(from = 'pointer') {
    if (source !== from) return;
    source = null;
    if (state === 'holding') {
      if (now() - downAt >= limit()) {
        set('idle');
        call(effects.stop, true);
      } else {
        set('toggled');
      }
    } else if (state === 'toggled' && stopTap) {
      stopTap = false;
      sent();
    } else if (state === 'listening' && stopTap) {
      stopTap = false;
      set('idle');
      call(effects.unlisten);
    }
  }

  // The turn ended by rule (a long talk followed by a long silence): stop and send as if released
  function end() {
    if (state !== 'holding' && state !== 'toggled') return;
    const was = state;
    source = null;
    stopTap = false;
    if (was === 'toggled') return sent();
    set('idle');
    call(effects.stop, true);
  }

  // Close the microphone while listening (the meeting is over)
  function leave() {
    if (state !== 'listening') return;
    source = null;
    stopTap = false;
    set('idle');
    call(effects.unlisten);
  }

  // The microphone could not start or stopped: back to idle, and the error goes out through onChange
  function fail(err) {
    const was = state;
    source = null;
    stopTap = false;
    set('idle', err || new Error('recording failed'));
    if (was === 'listening') call(effects.unlisten);
  }

  return { down, up, end, leave, fail, get state() { return state; }, get error() { return error; } };
}

const browserMedia = () => ({
  getStream: () => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md || !md.getUserMedia) return Promise.reject(new Error('The microphone needs a secure page (https or localhost)'));
    return md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  },
  createRecorder: (stream) => new MediaRecorder(stream),
  createMeter: (stream) => {
    const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return null;
    const ctx = new Ctor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser); // not connected to the speakers
    const buf = new Float32Array(analyser.fftSize);
    return {
      read() {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        analyser.getFloatTimeDomainData(buf);
        return rmsOf(buf);
      },
      close() { try { src.disconnect(); ctx.close(); } catch (_) {} },
      info: () => ({ state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency }),
    };
  },
});

const isEditable = (el) => !!el && (TEXT_TAGS.has(el.tagName) || el.isContentEditable === true);
const defaultTyping = () => typeof document !== 'undefined' && isEditable(document.activeElement);

// onSend(blob, mime, { turn, part, final }) gets each part of the recording (the last has final = true and may
// be empty when earlier parts went out); onCancel() is called when nothing will be sent at all (the mic failed,
// or the recording was empty). Every press ends in a final part or onCancel.
// autoEnd: { afterSeconds, quietSeconds } or a function returning it; a recording that ran afterSeconds and then
// heard quietSeconds of silence is stopped and sent. 0 or missing turns it off.
// interimSeconds: number or function; 0 turns the cutting off. onLevel(0..1) and onPause(bool) report the input.
// handsFree: { enabled, startLevel, startMs, speakingLevel, speakingMs, minChars, quietSeconds, maxSeconds } or a function
// returning it (see HANDS_FREE_DEFAULTS). isSpeaking(): the AI voice is audible. onHear(bool): a speech start was
// detected while listening and its recording has not been sent yet.
export function createTalk({ holdMs = DEFAULT_HOLD_MS, interimSeconds = DEFAULT_INTERIM_SECONDS, autoEnd = null, handsFree = null, isSpeaking, onHear, onPress, onSend, onCancel, onLevel, onPause, onDiag, unlock, enabled, now, isTyping, media, timers = {} } = {}) {
  const clock = now || (() => Date.now());
  const every = timers.setInterval || ((fn, ms) => {
    const id = setInterval(fn, ms);
    if (id && typeof id.unref === 'function') id.unref(); // node (tests) only: a forgotten recording must not keep the process alive
    return id;
  });
  const stopEvery = timers.clearInterval || ((id) => clearInterval(id));
  // interimSeconds may be a list: the n-th cut uses the n-th value and the last one repeats, so cuts can grow longer
  const interimMs = (part = 0) => {
    const raw = typeof interimSeconds === 'function' ? interimSeconds() : interimSeconds;
    const list = Array.isArray(raw) ? raw : [raw];
    const v = Number(list[Math.min(part, list.length - 1)]);
    return Number.isFinite(v) ? v * 1000 : DEFAULT_INTERIM_SECONDS * 1000;
  };
  const detector = createPauseDetector();
  const starter = createStartDetector();
  const hf = () => ({ ...HANDS_FREE_DEFAULTS, ...((typeof handsFree === 'function' ? handsFree() : handsFree) || {}) });
  let lis = null; // listening: { ticker, cand }
  let hearing = false;
  let meter = null;
  let pausedNow = false;
  const listeners = new Set();
  const mic = media || browserMedia();
  let stream = null; // kept between recordings, so the browser asks for the microphone only once
  let opening = null;
  let attempts = 0;
  let cur = null; // the recording that has not been stopped yet

  const machine = createTalkMachine({
    holdMs,
    now,
    enabled,
    onChange: (state, error) => { for (const fn of [...listeners]) call(fn, state, error); },
    handsFree: () => hf().enabled !== false && !!meter,
    effects: { press: () => call(onPress), start, stop, listen, unlisten },
  });

  const diag = (event, data) => { if (onDiag) call(onDiag, event, data); };
  const trackInfo = (s) => {
    const t = s.getAudioTracks()[0];
    if (!t) return { tracks: 0 };
    const set = typeof t.getSettings === 'function' ? t.getSettings() : {};
    return { tracks: s.getAudioTracks().length, readyState: t.readyState, sampleRate: set.sampleRate, channelCount: set.channelCount, echoCancellation: set.echoCancellation, noiseSuppression: set.noiseSuppression, autoGainControl: set.autoGainControl };
  };
  const live = (s) => s.getAudioTracks().some((t) => t.readyState === 'live');
  function closeMeter() {
    if (meter) {
      try { diag('meter-close', typeof meter.info === 'function' ? meter.info() : {}); } catch (_) {}
      try { meter.close(); } catch (_) {}
    }
    meter = null;
  }
  function ensureStream() {
    if (stream && live(stream)) return Promise.resolve(stream);
    stream = null;
    closeMeter();
    if (!opening) {
      opening = mic.getStream()
        .then((s) => {
          stream = s;
          diag('mic-open', trackInfo(s));
          watch(s);
          if (mic.createMeter) {
            try { meter = mic.createMeter(s); } catch (e) { console.error(e); meter = null; }
            if (meter) { try { diag('meter-open', typeof meter.info === 'function' ? meter.info() : {}); } catch (_) {} }
          }
          return s;
        }, (e) => {
          diag('mic-open-failed', { name: e && e.name, message: String((e && e.message) || e).slice(0, 200) });
          throw e;
        })
        .finally(() => { opening = null; });
    }
    return opening;
  }
  // The system can take the microphone away (screen lock, another app)
  function watch(s) {
    for (const t of s.getAudioTracks()) {
      t.addEventListener('ended', () => {
        diag('mic-ended', { current: stream === s });
        if (stream === s) { stream = null; closeMeter(); }
        if (machine.state === 'listening' && !stream) machine.fail(new Error('The microphone stopped'));
        const a = cur;
        if (a && a.stream === s) { cur = null; finish(a, false); machine.fail(new Error('The microphone stopped')); }
      });
    }
  }

  const blobOf = (seg) => (seg.chunks.length ? new Blob(seg.chunks, { type: (seg.rec && seg.rec.mimeType) || seg.chunks[0].type || '' }) : null);

  // Stop one segment's recorder and hand over its blob (null when it recorded nothing)
  function closeSegment(seg, done) {
    const rec = seg.rec;
    const settle = () => done(blobOf(seg));
    if (!rec || rec.state === 'inactive') return settle();
    rec.onstop = settle;
    try { rec.stop(); } catch (_) { settle(); }
  }

  function beginSegment(a) {
    const rec = mic.createRecorder(a.stream);
    const seg = { rec, chunks: [] };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) seg.chunks.push(e.data); };
    rec.start();
    a.seg = seg;
    a.segAt = clock();
    if (rec.mimeType) a.mime = rec.mimeType;
  }

  // One part of the turn leaves; the final part always leaves when earlier parts did, so the turn can close
  function emitPart(a, blob, part, final) {
    if (blob) return call(onSend, blob, blob.type, { turn: a.turn, part, final });
    if (!final) return;
    if (a.part > 0) call(onSend, new Blob([], { type: a.mime || '' }), a.mime || '', { turn: a.turn, part, final: true });
    else call(onCancel);
  }

  // Restart the recorder: the new segment starts before the old one is closed, so no audio falls between them
  function rotate(a) {
    const old = a.seg;
    const part = a.part++;
    try { beginSegment(a); } catch (e) { console.error(e); }
    closeSegment(old, (blob) => emitPart(a, blob, part, false));
  }

  function setPaused(on) {
    if (pausedNow === on) return;
    pausedNow = on;
    call(onPause, on);
  }

  function tick(a) {
    if (cur !== a) return;
    const t = clock();
    if (meter) {
      const rms = meter.read();
      call(onLevel, Math.min(1, rms * LEVEL_GAIN));
      setPaused(detector.feed(rms, t));
      a.quietSince = rms < PAUSE_THRESHOLD ? a.quietSince ?? t : null;
      const ae = (typeof autoEnd === 'function' ? autoEnd() : autoEnd) || {};
      if (turnOver({ startedAt: a.startedAt, quietSince: a.quietSince, now: t, afterMs: Number(ae.afterSeconds) * 1000, quietMs: Number(ae.quietSeconds) * 1000 })) {
        machine.end();
        return;
      }
    }
    if (segmentDue({ startedAt: a.segAt, now: t, intervalMs: interimMs(a.part) })) rotate(a);
  }

  function endTicks(a) {
    if (a.ticker != null) { stopEvery(a.ticker); a.ticker = null; }
    detector.reset();
    setPaused(false);
    if (meter) call(onLevel, 0);
  }

  function finish(a, send) {
    endTicks(a);
    if (a.finished) return;
    a.finished = true;
    const seg = a.seg;
    const part = a.part;
    if (!seg) return emitPart(a, null, part, true);
    if (!send) { // the microphone is gone: what this segment holds is dropped
      closeSegment(seg, () => emitPart(a, null, part, true));
      return;
    }
    closeSegment(seg, (blob) => emitPart(a, blob, part, true));
  }

  // ---- Listening: the microphone is open and waits for the human to speak again ----
  const setHearing = (on) => {
    if (hearing === on) return;
    hearing = on;
    call(onHear, on);
  };

  function listen() {
    if (lis) return;
    starter.reset();
    lis = { ticker: null, cand: null };
    diag('listen-start', { ...hf() });
    lis.ticker = every(tickListen, TICK_MS);
  }

  function unlisten() {
    const l = lis;
    if (!l) return;
    lis = null;
    stopEvery(l.ticker);
    if (l.cand) dropCandidate(l.cand, 'closed');
    starter.reset();
    setHearing(false);
    call(onLevel, 0);
    diag('listen-stop', {});
  }

  // A loud level begins a candidate recording at once, so the first words are not lost; it is dropped when the level does not last
  function openCandidate(l, t, c) {
    const a = { turn: newTurn(), part: 0, seg: null, segAt: 0, stream, mime: '', startedAt: t, quietSince: null, confirmed: false, finished: false, min: c.minChars };
    try { beginSegment(a); } catch (e) { console.error(e); return; }
    l.cand = a;
  }

  function dropCandidate(a, reason, extra = {}) {
    if (a.finished) return;
    a.finished = true;
    if (lis && lis.cand === a) lis.cand = null;
    starter.reset();
    if (a.confirmed) setHearing(false);
    diag('listen-discard', { reason, ms: clock() - a.startedAt, confirmed: a.confirmed, ...extra });
    closeSegment(a.seg, () => {});
  }

  function endCandidate(a) {
    a.finished = true;
    if (lis && lis.cand === a) lis.cand = null;
    starter.reset();
    setHearing(false);
    diag('listen-end', { ms: clock() - a.startedAt });
    closeSegment(a.seg, (blob) => {
      if (blob) call(onSend, blob, blob.type, { turn: a.turn, part: 0, final: true, min: a.min });
      else diag('listen-discard', { reason: 'empty', confirmed: true });
    });
  }

  function tickListen() {
    const l = lis;
    if (!l || !meter) return;
    if (enabled && enabled() === false) return machine.leave();
    const t = clock();
    const rms = meter.read();
    const level = Math.min(1, rms * LEVEL_GAIN);
    call(onLevel, level);
    const c = hf();
    let speaking = false;
    try { speaking = !!(isSpeaking && isSpeaking()); } catch (_) {}
    const gate = speaking ? { threshold: Number(c.speakingLevel), ms: Number(c.speakingMs) } : { threshold: Number(c.startLevel), ms: Number(c.startMs) };
    const a = l.cand;
    if (a && a.confirmed) {
      a.quietSince = rms < PAUSE_THRESHOLD ? a.quietSince ?? t : null;
      if (listenOver({ startedAt: a.startedAt, quietSince: a.quietSince, now: t, quietMs: Number(c.quietSeconds) * 1000, maxMs: Number(c.maxSeconds) * 1000 })) endCandidate(a);
      return;
    }
    const run = starter.feed(level, t, gate);
    if (!a) {
      if (run !== 'none') openCandidate(l, t, c);
      return;
    }
    if (run === 'none') return dropCandidate(a, 'short');
    if (run === 'speech') {
      a.confirmed = true;
      diag('listen-speech', { level: Math.round(level * 100) / 100, ms: t - a.startedAt, speaking, threshold: gate.threshold });
      setHearing(true);
      call(onPress); // cut the AI voice
    }
  }

  const newTurn = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  function start() {
    const a = { id: ++attempts, turn: newTurn(), part: 0, seg: null, segAt: 0, stream: null, mime: '', ticker: null, ended: undefined, finished: false };
    cur = a;
    ensureStream()
      .then((s) => {
        if (a.ended !== undefined) { a.finished = true; return call(onCancel); } // released before the microphone was ready
        a.stream = s;
        beginSegment(a);
        a.startedAt = clock();
        a.quietSince = null;
        detector.reset();
        a.ticker = every(() => tick(a), TICK_MS);
      })
      .catch((err) => {
        if (cur === a) cur = null;
        if (!a.finished) { a.finished = true; call(onCancel); }
        if (attempts === a.id) machine.fail(err);
      });
  }

  function stop(send) {
    const a = cur;
    cur = null;
    if (!a) return;
    if (!a.seg) { a.ended = send; return; } // the microphone is still starting: start() concludes
    finish(a, send);
  }

  const typing = () => (isTyping ? isTyping() : defaultTyping());

  function bindButton(el) {
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
    el.style.webkitTouchCallout = 'none';
    const onDown = (e) => {
      if (e.button) return; // primary button or touch only
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      call(unlock);
      machine.down('pointer');
    };
    const onUp = () => {
      call(unlock);
      machine.up('pointer');
    };
    const noMenu = (e) => e.preventDefault();
    const events = [['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onUp], ['lostpointercapture', onUp], ['contextmenu', noMenu]];
    for (const [name, fn] of events) el.addEventListener(name, fn);
    return () => { for (const [name, fn] of events) el.removeEventListener(name, fn); };
  }

  function bindKey(target = document) {
    let held = false; // our Space press is down
    const onKeyDown = (e) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey || typing()) return;
      e.preventDefault();
      if (e.repeat || held) return;
      held = true;
      call(unlock);
      machine.down('key');
    };
    const onKeyUp = (e) => {
      if (e.code !== 'Space' || !held) return;
      e.preventDefault();
      held = false;
      call(unlock);
      machine.up('key');
    };
    // A key or finger lifted while the page was not looking never sends its release: treat it as released
    const letGo = () => {
      held = false;
      machine.up('key');
      machine.up('pointer');
    };
    const onHidden = () => { if (document.hidden) letGo(); };
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    if (typeof window !== 'undefined') window.addEventListener('blur', letGo);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden);
    return () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      if (typeof window !== 'undefined') window.removeEventListener('blur', letGo);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHidden);
    };
  }

  // Stop using the microphone (the meeting ended); the next press asks for it again
  function closeMic() {
    machine.leave();
    if (machine.state !== 'idle') return;
    if (stream) diag('mic-close', trackInfo(stream));
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    closeMeter();
  }

  return {
    bindKey,
    bindButton,
    closeMic,
    get state() { return machine.state; },
    get error() { return machine.error; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
