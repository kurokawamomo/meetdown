// Plays AI voices in arrival order on one Web Audio timeline (ported from the v1 page).
// Sentences are fetched as they arrive, decoded in order and scheduled back to back. When the speaker
// changes, the next voice may start `overlap` seconds before the previous one ends. While the human is
// recording (hold) nothing new is scheduled. stopAll() reports what the human interrupted.
//
// Murmurs (audio with murmur: true) play on their own track at 50% gain, one at a time. While the human records
// they are held, and released only while setPaused(true) (a detected pause) or after the recording ended; a murmur
// that has started may finish. A murmur starts only while no normal voice is audible, so at most two voices
// sound at once. expectFront(n) puts the next n murmur utterances ahead of the queued ones.
// Text for the balloons: onSentence(from, text, id) when a sentence of normal speech starts, onClear(from, id)
// when the utterance ends or is cut, onMurmur(id, from, text) when a murmur sentence starts.
//
// Beyond the contract: hold(on), setPaused(on), expectFront(n) and reset(). `overlap` may be a number or a function returning one.
// onPlay(id, from) fires when the first sentence of an utterance becomes audible (not when it is queued),
// onDone(id) when its last sentence has finished, onSpeaking(names) whenever the set of audible
// speakers changes (two speakers are audible while their voices overlap; the newest is last).

const TICK_MS = 50;
const FETCH_TIMEOUT_MS = 15000;
const MURMUR_GAIN = 0.5;
const FRONT_EXPIRE_MS = 4000;
const HEARD_IN_PART_SEC = 10; // a half-heard utterance still counts as "playing" this long after a sentence ended

export function createPlayer({ overlap = 1, onPlay, onDone, onSpeaking, onSentence, onClear, onMurmur, env = {} } = {}) {
  let ctx = null;
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
  let paused = false; // a pause in the human's speech was detected
  let front = { count: 0, ids: new Set(), until: 0 };

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

  // ---- Browser audio unlock: needs a user gesture; safe to call on every gesture ----
  function unlock() {
    if (!ctx) {
      const Ctor = env.AudioContext || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
      if (!Ctor) return;
      try { ctx = new Ctor(); } catch (e) { return console.error(e); }
      ctx.onstatechange = () => { tick(); pump(); pumpMurmurs(); };
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
    if (pumping || held || !ctx) return;
    pumping = true;
    try {
      while (waiting.length && !held) {
        const a = waiting[0];
        if (!a.loaded) {
          const raw = await a.raw;
          a.audio = raw ? await decode(raw).catch(() => null) : null;
          a.loaded = true;
        }
        if (waiting[0] !== a) continue; // removed while loading; look at the new head
        if (held) break; // recording started; keep it for later (already decoded)
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
    src.connect(ctx.destination);
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
    const names = [...new Set(audible().map((it) => it.from))];
    const key = names.join('\n');
    if (key !== spoken) { spoken = key; call(onSpeaking, names); }
    if (mwaiting.length) pumpMurmurs();
    if (!items.length && !mplaying && !mwaiting.length && timer) { stopEvery(timer); timer = null; }
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
  const murmurAllowed = () => !held || paused;

  function enqueueMurmur(a) {
    const ctrl = new AbortController();
    const m = { id: a.id, seq: a.seq, from: a.from, text: a.text || '', ctrl, raw: fetchRaw(a.url, ctrl), loaded: false, audio: null };
    const now = Date.now();
    if (front.count > 0 && now > front.until) front = { count: 0, ids: new Set(), until: 0 };
    let at = mwaiting.length;
    if (front.ids.has(a.id)) { // a thought that was asked for goes after the earlier ones of its kind, before the rest
      at = 0;
      while (at < mwaiting.length && front.ids.has(mwaiting[at].id)) at++;
    } else if (front.count > 0) {
      front.ids.add(a.id);
      front.count--;
      at = 0;
      while (at < mwaiting.length && front.ids.has(mwaiting[at].id)) at++;
    }
    mwaiting.splice(at, 0, m);
    pumpMurmurs();
  }

  // Next n murmur utterances to arrive (for example the voiced thoughts) play before the queued ones
  function expectFront(n) {
    front = { count: Math.max(0, n | 0), ids: new Set(), until: Date.now() + FRONT_EXPIRE_MS };
  }

  async function pumpMurmurs() {
    if (mpumping || !ctx) return;
    mpumping = true;
    try {
      while (mwaiting.length && !mplaying && murmurAllowed()) {
        const m = mwaiting[0];
        if (!m.loaded) {
          const raw = await m.raw;
          m.audio = raw ? await decode(raw).catch(() => null) : null;
          m.loaded = true;
        }
        if (mwaiting[0] !== m) continue;
        if (!murmurAllowed() || audible().length) break; // tick() tries again
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
    gain.gain.value = MURMUR_GAIN;
    src.buffer = m.audio;
    src.connect(gain);
    gain.connect(ctx.destination);
    mplaying = { src, gain };
    src.onended = () => {
      try { src.disconnect(); gain.disconnect(); } catch (_) {}
      mplaying = null;
      tick();
      pumpMurmurs();
    };
    src.start();
    if (!timer) timer = every(tick, TICK_MS);
    call(onMurmur, m.id, m.from, m.text);
  }

  // The human paused (true) or went on talking (false): murmurs are released during a pause
  function setPaused(on) {
    paused = !!on;
    if (paused) pumpMurmurs();
  }

  // Block (true) or allow (false) putting new sentences on the timeline; arrivals still download
  function hold(on) {
    held = !!on;
    if (!held) { pump(); pumpMurmurs(); }
  }

  // A new meeting restarts utterance ids: forget everything, including the silenced ids
  function reset() {
    stopAll();
    for (const m of mwaiting.splice(0)) m.ctrl.abort();
    front = { count: 0, ids: new Set(), until: 0 };
    silenced.clear();
  }

  return { unlock, enqueue, stopAll, speakingFrom, silence, hold, setPaused, expectFront, reset };
}
