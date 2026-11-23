// Plays AI voices in arrival order on one Web Audio timeline (ported from the v1 page).
// Sentences are fetched as they arrive, decoded in order and scheduled back to back. When the speaker
// changes, the next voice may start `overlap` seconds before the previous one ends. While the human is
// recording (hold) nothing new is scheduled. stopAll() reports what the human interrupted.
//
// Murmurs (audio with murmur: true) play on their own track at 50% gain, one at a time. One voice at a time,
// by rule and not by anyone's judgement: while the human records nothing plays (a murmur that is sounding is
// cut), a murmur starts only while no normal voice is audible, and a normal voice waits for a sounding murmur.
// The exceptions: a short murmur (SHORT_MURMUR characters at most) and a voiced thought (thought: true) may sound over
// the human, quieter while the human is loud (setInputLevel). A voiced thought is quieter still and fades out early,
// so it is heard as someone about to speak.
// Text for the balloons: onSentence(from, text, id) when a sentence of normal speech starts, onClear(from, id)
// when the utterance ends or is cut, onMurmur(id, from, text) when a murmur sentence starts.
//
// Beyond the contract: hold(on), setInputLevel(0..1) and reset(). `overlap` may be a number or a function returning one.
// onPlay(id, from) fires when the first sentence of an utterance becomes audible (not when it is queued),
// onDone(id) when its last sentence has finished, onSpeaking(names) whenever the set of audible
// speakers changes (two speakers are audible while their voices overlap; the newest is last).

const TICK_MS = 50;
const FETCH_TIMEOUT_MS = 15000;
const MURMUR_GAIN = 0.5;
const SHORT_MURMUR = 10; // characters
const LOUD_INPUT = 0.35; // input level above which a murmur over the human is ducked
const DUCKED_GAIN = 0.2;
const THOUGHT_GAIN = 0.15;
const FRESH_GESTURE_MS = 1000; // a gesture this recent still lets a new context start
const HEARD_IN_PART_SEC = 10; // a half-heard utterance still counts as "playing" this long after a sentence ended

export function createPlayer({ overlap = 1, onPlay, onDone, onSpeaking, onSentence, onClear, onMurmur, onDiag, env = {} } = {}) {
  let ctx = null;
  let gen = 0; // how many contexts this player has made
  let master = null; // passes every voice on to the speakers; its level tells whether sound leaves the page
  let levelBuf = null;
  let held = false; // the human is recording: nothing new is scheduled
  let pumping = false;
  let nextAt = 0; // timeline position for the next sentence (previous end plus its gap)
  let lastFrom = null;
  let timer = null;
  let spoken = ''; // audible speakers joined, to detect changes for onSpeaking
  const silenced = new Set(); // cut or dropped utterances; their late audio is not played
  const waiting = []; // arrived, not scheduled yet
  const items = []; // scheduled sentences, including ones that start later
  const between = new Map(); // utterance id -> { seq, at }: heard in part, sentence `seq` is next
  const announced = new Map(); // utterances onPlay has fired for: id -> from
  const mwaiting = []; // murmur sentences, arrived and not played yet
  let mplaying = null; // the murmur sentence sounding now
  let mpumping = false;

  const every = env.setInterval || ((fn, ms) => setInterval(fn, ms));
  const stopEvery = env.clearInterval || ((id) => clearInterval(id));
  const doFetch = env.fetch || ((...args) => fetch(...args));
  const overlapSec = () => {
    const v = Number(typeof overlap === 'function' ? overlap() : overlap);
    return v > 0 ? v : 0;
  };
  const call = (fn, ...args) => {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) { console.error(e); }
  };

  // Reports to onDiag: the event, what the context looks like now, and anything the caller adds
  const ctxInfo = () => (ctx ? { gen, state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency, currentTime: Math.round(ctx.currentTime * 1000) / 1000 } : { gen, state: 'none' });
  const diag = (event, extra) => { if (onDiag) call(onDiag, event, { ctx: ctxInfo(), ...extra }); };
  const sink = () => master || ctx.destination;
  // RMS (0..1) of what is being played, taken from the analyser in front of the speakers
  function level() {
    if (!master || !master.getFloatTimeDomainData) return 0;
    try {
      if (!levelBuf) levelBuf = new Float32Array(master.fftSize || 1024);
      master.getFloatTimeDomainData(levelBuf);
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
      return Math.sqrt(sum / levelBuf.length);
    } catch (_) { return 0; }
  }
  const noteLevel = (box, v) => { box.rmsMax = Math.max(box.rmsMax || 0, v); box.rmsSum = (box.rmsSum || 0) + v; box.rmsN = (box.rmsN || 0) + 1; };
  const levelOf = (box) => ({ rmsMax: Math.round((box.rmsMax || 0) * 10000) / 10000, rmsMean: box.rmsN ? Math.round((box.rmsSum / box.rmsN) * 10000) / 10000 : null, samples: box.rmsN || 0 });

  // ---- Browser audio unlock: needs a user gesture; safe to call on every gesture ----
  function makeContext(reason) {
    const Ctor = env.AudioContext || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
    if (!Ctor) return false;
    try { ctx = new Ctor(); } catch (e) { console.error(e); return false; }
    gen++;
    levelBuf = null;
    master = null;
    try {
      master = ctx.createAnalyser();
      master.fftSize = 1024;
      master.connect(ctx.destination);
    } catch (_) { master = null; }
    ctx.onstatechange = () => { diag('ctx-state', {}); tick(); pump(); pumpMurmurs(); };
    diag('ctx-create', { reason, analyser: !!master });
    return true;
  }
  function unlock(gesture) {
    if (!ctx && !makeContext('unlock')) return;
    diag('unlock', { gesture: gesture !== false, renewPending });
    if (gesture !== false) { // event listeners pass the event; only the visibility handler passes false
      lastGestureAt = now();
      if (renewPending) renewNow(); // inside a gesture the new context may start by itself
      if (!ctx) return;
    }
    if (ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && typeof p.then === 'function') p.then(() => { tick(); pump(); }, () => {});
    }
    pump(); // audio that arrived before the first gesture
    pumpMurmurs();
  }

  const decode = (raw) => new Promise((ok, ng) => {
    const p = ctx.decodeAudioData(raw, ok, ng);
    if (p && typeof p.catch === 'function') p.catch(() => {}); // the callbacks already report; avoid an unhandled rejection
  });
  function fetchRaw(url, ctrl) {
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    return doFetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
      .finally(() => clearTimeout(t));
  }

  // a: { id, seq, url, gap, last, from }
  function enqueue(a) {
    if (!a || silenced.has(a.id)) return;
    if (a.murmur) return enqueueMurmur(a);
    const ctrl = new AbortController();
    waiting.push({ id: a.id, seq: a.seq, from: a.from, text: a.text || '', gap: Number(a.gap) || 0, last: !!a.last, ctrl, raw: fetchRaw(a.url, ctrl), loaded: false, audio: null });
    pump();
  }

  // Decode in arrival order and put each sentence on the timeline
  async function pump() {
    if (pumping || held || mplaying || !ctx) return;
    pumping = true;
    try {
      while (waiting.length && !held && !mplaying) {
        const a = waiting[0];
        if (!a.loaded) {
          const raw = await a.raw;
          a.audio = raw ? await decode(raw).catch(() => null) : null;
          a.loaded = true;
        }
        if (waiting[0] !== a) continue; // removed while loading; look at the new head
        if (held || mplaying) break; // recording or a murmur started; keep it for later (already decoded)
        waiting.shift();
        if (silenced.has(a.id)) continue;
        if (!a.audio) { // could not load: skip the sentence, but still close the utterance
          if (a.last) { between.delete(a.id); finishUtterance(a.id, a.from); call(onDone, a.id); }
          continue;
        }
        schedule(a, a.audio);
      }
    } finally {
      pumping = false;
    }
  }

  function schedule(a, buf) {
    const changed = lastFrom !== null && lastFrom !== a.from;
    const at = Math.max(ctx.currentTime, nextAt - (changed ? overlapSec() : 0));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(sink());
    const it = { id: a.id, seq: a.seq, from: a.from, text: a.text, last: a.last, src, start: at, end: at + buf.duration, started: false };
    src.onended = () => ended(it);
    src.start(at);
    items.push(it);
    nextAt = it.end + a.gap;
    lastFrom = a.from;
    if (!timer) timer = every(tick, TICK_MS);
    tick();
  }

  function markStarted(it) {
    it.started = true;
    if (silenced.has(it.id)) return;
    between.delete(it.id);
    diag('play-start', { id: it.id, seq: it.seq, from: it.from, late: ctx ? Math.round((ctx.currentTime - it.start) * 1000) / 1000 : null });
    if (!announced.has(it.id)) { announced.set(it.id, it.from); call(onPlay, it.id, it.from); }
    call(onSentence, it.from, it.text, it.id);
  }

  // The utterance is over (or cut): its balloon goes
  function finishUtterance(id, from) {
    const was = announced.delete(id);
    if (was) call(onClear, from, id);
  }

  function ended(it) {
    const i = items.indexOf(it);
    if (i < 0) return; // already removed by silence() or stopAll()
    items.splice(i, 1);
    detach(it);
    if (!it.started) markStarted(it);
    diag('play-end', { id: it.id, seq: it.seq, last: it.last, duration: Math.round((it.end - it.start) * 1000) / 1000, ...levelOf(it) });
    if (!silenced.has(it.id)) {
      if (it.last) { between.delete(it.id); finishUtterance(it.id, it.from); call(onDone, it.id); }
      else between.set(it.id, { seq: it.seq + 1, at: ctx.currentTime });
    }
    tick();
  }

  function detach(it) {
    it.src.onended = null;
    try { it.src.disconnect(); } catch (_) {}
  }
  function kill(it) {
    detach(it);
    try { it.src.stop(); } catch (_) {}
  }

  // Sentences that are sounding right now, oldest first (two overlap when the speaker changes)
  function audible() {
    if (!ctx || ctx.state !== 'running') return [];
    const t = ctx.currentTime;
    return items.filter((it) => it.start <= t && t < it.end).sort((x, y) => x.start - y.start);
  }

  // Announces sentences that have just become audible and changes of who is audible; stops itself when nothing is scheduled
  function tick() {
    if (ctx && ctx.state === 'running') {
      const t = ctx.currentTime;
      for (const it of items) if (!it.started && t >= it.start) markStarted(it);
    }
    const sounding = audible();
    if (master && (sounding.length || mplaying)) {
      const v = level();
      for (const it of sounding) noteLevel(it, v);
      if (mplaying) noteLevel(mplaying, v);
    }
    const names = [...new Set(sounding.map((it) => it.from))];
    const key = names.join('\n');
    if (key !== spoken) { spoken = key; call(onSpeaking, names); }
    if (mwaiting.length) pumpMurmurs();
    if (!items.length && !mplaying && !mwaiting.length && timer) { stopEvery(timer); timer = null; }
  }

  // ---- Output renewal (Safari) ----
  // After the microphone has been opened and closed, WebKit can leave an AudioContext that reports "running" and
  // accepts sources but makes no sound until the browser restarts. So when the microphone is released the context
  // is closed and a new one is made. Decoded AudioBuffers belong to no context and play in the new one.
  // A context made outside a user gesture stays suspended until the next click (autoEnd and the release timer
  // run outside one), so renewOutput() only marks the renewal as needed; it happens in the next unlock(), which
  // runs inside a gesture, or in hold(false) when a gesture has just happened. Nothing is renewed while a sentence
  // is being decoded (the decode would fail on a closed context) or while anything is scheduled, sounding or held.
  const isSafari = () => {
    if (typeof env.renewOutput === 'boolean') return env.renewOutput;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|Edg\//.test(ua);
  };
  let renewPending = false;
  let lastGestureAt = -Infinity;
  const now = env.now || (() => Date.now());
  function renewOutput() { // the microphone was released: mark only
    if (ctx && isSafari()) renewPending = true;
    diag('renew-mark', { marked: renewPending });
  }
  function renewNow() {
    if (!ctx || !renewPending) return;
    if (held || pumping || mpumping || items.length || mplaying) return;
    renewPending = false;
    diag('ctx-renew', { sinceGesture: Math.round(now() - lastGestureAt) });
    const old = ctx;
    old.onstatechange = null;
    ctx = null;
    nextAt = 0; // the new timeline starts at 0
    lastFrom = null;
    try { const p = old.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {}
    if (!makeContext('renew')) return;
    for (const b of between.values()) b.at = ctx.currentTime;
    const p = ctx.resume(); // may stay suspended until the next gesture; unlock() resumes it then
    if (p && typeof p.then === 'function') p.then(() => { tick(); pump(); pumpMurmurs(); }, () => {});
    pump();
    pumpMurmurs();
  }

  function speakingFrom() {
    const a = audible();
    return a.length ? a[a.length - 1].from : null;
  }

  // The human started talking: stop everything. Returns the utterance being heard (and its sentence) and
  // the utterances that had not started. Their late audio is ignored from now on. While two voices overlap,
  // the older one counts as the one that was cut: the newer one has barely begun.
  function stopAll() {
    const first = audible()[0];
    let playing = first ? { id: first.id, seq: first.seq } : null;
    if (!playing && ctx) { // between two sentences of one utterance
      let best = null;
      for (const [id, b] of between) {
        if (!silenced.has(id) && ctx.currentTime - b.at < HEARD_IN_PART_SEC && (!best || b.at >= best.at)) best = { id, seq: b.seq, at: b.at };
      }
      if (best) playing = { id: best.id, seq: best.seq };
    }
    diag('stop-all', { items: items.length, waiting: waiting.length, playing: playing ? playing.id : null });
    const pending = new Set();
    for (const it of items.splice(0)) { pending.add(it.id); kill(it); }
    for (const w of waiting.splice(0)) { pending.add(w.id); w.ctrl.abort(); }
    for (const id of pending) silenced.add(id);
    for (const id of between.keys()) silenced.add(id);
    if (playing) { silenced.add(playing.id); pending.delete(playing.id); }
    between.clear();
    for (const [id, from] of [...announced]) finishUtterance(id, from);
    nextAt = 0;
    lastFrom = null;
    tick();
    return { playing, pending: [...pending] };
  }

  // The server marked an utterance cut or dropped: its audio must not play
  function silence(id) {
    silenced.add(id);
    for (let i = mwaiting.length - 1; i >= 0; i--) if (mwaiting[i].id === id) { mwaiting[i].ctrl.abort(); mwaiting.splice(i, 1); }
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].id === id) { waiting[i].ctrl.abort(); waiting.splice(i, 1); }
    for (let i = items.length - 1; i >= 0; i--) if (items[i].id === id) { kill(items[i]); items.splice(i, 1); }
    between.delete(id);
    const from = announced.get(id);
    if (from !== undefined) finishUtterance(id, from);
    tick();
  }

  // ---- Murmurs ----
  const isShort = (m) => m.thought || [...(m.text || '')].length <= SHORT_MURMUR;
  const murmurAllowed = (m) => !held || isShort(m);
  let inputLevel = 0;
  const murmurGain = (thought) => Math.min(thought ? THOUGHT_GAIN : MURMUR_GAIN, held && inputLevel > LOUD_INPUT ? DUCKED_GAIN : 1);

  function enqueueMurmur(a) {
    const ctrl = new AbortController();
    const m = { id: a.id, seq: a.seq, from: a.from, text: a.text || '', thought: !!a.thought, ctrl, raw: fetchRaw(a.url, ctrl), loaded: false, audio: null };
    mwaiting.push(m);
    pumpMurmurs();
  }

  async function pumpMurmurs() {
    if (mpumping || !ctx) return;
    mpumping = true;
    try {
      while (mwaiting.length && !mplaying && murmurAllowed(mwaiting[0])) {
        const m = mwaiting[0];
        if (!m.loaded) {
          const raw = await m.raw;
          m.audio = raw ? await decode(raw).catch(() => null) : null;
          m.loaded = true;
        }
        if (mwaiting[0] !== m) continue;
        if (!murmurAllowed(m) || items.length) break; // a normal voice is sounding or scheduled; tick() tries again
        mwaiting.shift();
        if (silenced.has(m.id) || !m.audio) continue;
        playMurmur(m);
      }
    } finally {
      mpumping = false;
    }
  }

  function playMurmur(m) {
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = murmurGain(m.thought);
    if (m.thought) gain.gain.linearRampToValueAtTime(0, ctx.currentTime + m.audio.duration * 0.5); // quiet from the start, gone by the middle
    src.buffer = m.audio;
    src.connect(gain);
    gain.connect(sink());
    mplaying = { src, gain, short: isShort(m), thought: m.thought };
    src.onended = () => {
      try { src.disconnect(); gain.disconnect(); } catch (_) {}
      if (mplaying && mplaying.src === src) { diag('murmur-end', { id: m.id, ...levelOf(mplaying) }); mplaying = null; }
      tick();
      pump();
      pumpMurmurs();
    };
    src.start();
    diag('murmur-start', { id: m.id, from: m.from, thought: m.thought });
    if (!timer) timer = every(tick, TICK_MS);
    if (!m.thought) call(onMurmur, m.id, m.from, m.text); // a thought already shows in its own balloon
  }

  // The human's input level (0..1): a murmur sounding over the human is ducked while the human is loud
  function setInputLevel(level) {
    inputLevel = Number(level) || 0;
    if (mplaying && ctx && !mplaying.thought) mplaying.gain.gain.setTargetAtTime(murmurGain(false), ctx.currentTime, 0.05); // a thought keeps its fade
  }

  // Block (true) or allow (false) putting new sentences on the timeline; arrivals still download
  function hold(on) {
    const was = held;
    held = !!on;
    if (held !== was) diag('hold', { held });
    if (held && mplaying && !mplaying.short) { // the human speaks: a sounding murmur stops at once (a short one may go on)
      const { src, gain } = mplaying;
      mplaying = null;
      src.onended = null;
      try { src.stop(); src.disconnect(); gain.disconnect(); } catch (_) {}
    }
    if (!held) {
      if (was) renewOutput(); // the microphone was in use
      if (now() - lastGestureAt < FRESH_GESTURE_MS) renewNow(); // released by hand: renew before anything is put on the timeline
      pump();
      pumpMurmurs();
    }
  }

  // A new meeting restarts utterance ids: forget everything, including the silenced ids
  function reset() {
    stopAll();
    for (const m of mwaiting.splice(0)) m.ctrl.abort();
    silenced.clear();
  }

  return { unlock, enqueue, stopAll, speakingFrom, silence, hold, setInputLevel, reset, renewOutput };
}
