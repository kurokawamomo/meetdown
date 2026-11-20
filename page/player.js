// Plays AI voices in arrival order on one Web Audio timeline (ported from the v1 page).
// Sentences are fetched as they arrive, decoded in order and scheduled back to back. When the speaker
// changes, the next voice may start `overlap` seconds before the previous one ends. While the human is
// recording (hold) nothing new is scheduled. stopAll() reports what the human interrupted.
//
// Beyond the contract: hold(on) and reset(). `overlap` may be a number or a function returning one.
// onPlay(id, from) fires when the first sentence of an utterance becomes audible (not when it is queued),
// onDone(id) when its last sentence has finished, onSpeaking(names) whenever the set of audible
// speakers changes (two speakers are audible while their voices overlap; the newest is last).

const TICK_MS = 50;
const FETCH_TIMEOUT_MS = 15000;
const HEARD_IN_PART_SEC = 10; // a half-heard utterance still counts as "playing" this long after a sentence ended

export function createPlayer({ overlap = 1, onPlay, onDone, onSpeaking, env = {} } = {}) {
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
  const announced = new Set(); // utterances onPlay has fired for

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
      ctx.onstatechange = () => { tick(); pump(); };
    }
    if (ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && typeof p.then === 'function') p.then(() => { tick(); pump(); }, () => {});
    }
    pump(); // audio that arrived before the first gesture
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
    const ctrl = new AbortController();
    waiting.push({ id: a.id, seq: a.seq, from: a.from, gap: Number(a.gap) || 0, last: !!a.last, ctrl, raw: fetchRaw(a.url, ctrl), loaded: false, audio: null });
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
          if (a.last) { between.delete(a.id); announced.delete(a.id); call(onDone, a.id); }
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
    const it = { id: a.id, seq: a.seq, from: a.from, last: a.last, src, start: at, end: at + buf.duration, started: false };
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
    if (!announced.has(it.id)) { announced.add(it.id); call(onPlay, it.id, it.from); }
  }

  function ended(it) {
    const i = items.indexOf(it);
    if (i < 0) return; // already removed by silence() or stopAll()
    items.splice(i, 1);
    detach(it);
    if (!it.started) markStarted(it);
    if (!silenced.has(it.id)) {
      if (it.last) { between.delete(it.id); announced.delete(it.id); call(onDone, it.id); }
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
    if (!items.length && timer) { stopEvery(timer); timer = null; }
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
    announced.clear();
    nextAt = 0;
    lastFrom = null;
    tick();
    return { playing, pending: [...pending] };
  }

  // The server marked an utterance cut or dropped: its audio must not play
  function silence(id) {
    silenced.add(id);
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].id === id) { waiting[i].ctrl.abort(); waiting.splice(i, 1); }
    for (let i = items.length - 1; i >= 0; i--) if (items[i].id === id) { kill(items[i]); items.splice(i, 1); }
    between.delete(id);
    announced.delete(id);
    tick();
  }

  // Block (true) or allow (false) putting new sentences on the timeline; arrivals still download
  function hold(on) {
    held = !!on;
    if (!held) pump();
  }

  // A new meeting restarts utterance ids: forget everything, including the silenced ids
  function reset() {
    stopAll();
    silenced.clear();
  }

  return { unlock, enqueue, stopAll, speakingFrom, silence, hold, reset };
}
