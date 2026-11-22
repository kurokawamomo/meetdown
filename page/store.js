// Page state, fed by the server's event stream (SSE).
//   state:     one object, never replaced. Server events change its fields; arrays and objects are replaced
//              rather than edited, so a changed field is a new reference.
//   subscribe: fn(state) after every state change, batched to one call per animation frame
//   on:        fn(data) for each server event, right when it arrives (not batched), after state was updated.
//              Types: snapshot utterance roster meeting summary audio stop note signal thought murmur inviteAsk
//              baton share scroll interim, plus
//              'connected' and 'disconnected' for the stream itself.
// Beyond the contract: state.connected, close(), and patch(fields) for fields the page itself owns
// (app.js keeps `speaking`, the names whose voice is audible; a snapshot never clears them).

const EVENT_TYPES = ['snapshot', 'utterance', 'roster', 'meeting', 'summary', 'audio', 'stop', 'note', 'signal', 'thought', 'murmur', 'inviteAsk', 'baton', 'share', 'scroll', 'interim'];
const MAX_TURNS = 5; // live turns kept in state.interim
const CLOSED = 2; // EventSource.readyState: the browser gave up and will not reconnect by itself
const FLUSH_FALLBACK_MS = 100; // background tabs do not run animation frames

// The fields a snapshot replaces
const serverDefaults = () => ({
  meeting: null,
  participants: [],
  baton: [], // names of the participants expected to answer by voice
  share: null, // { id, kind, src, caption, version, by } or null
  scroll: null, // { percent } of the last scroll event
  interim: {}, // live text of the turns being spoken: { [turn]: { text, parts: { [n]: text }, at } }
  interimSeconds: [15, 20, 25],
  list: [],
  ui: {},
  lang: 'en',
  overlap: 0,
  holdMs: 300,
  tastes: null,
  me: { owner: '' },
  summary: null,
});

const summaryOf = (list) => {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === 'summary') return list[i].text;
  return null;
};

// Replace the utterance with the same id, or insert it in id order (normally at the end)
function upsert(list, u) {
  const next = list.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].id === u.id) { next[i] = u; return next; }
    if (next[i].id < u.id) { next.splice(i + 1, 0, u); return next; }
  }
  next.unshift(u);
  return next;
}

export function createStore(url = '/events', env = {}) {
  const state = { connected: false, ...serverDefaults() };
  const subs = new Set();
  const handlers = new Map();
  let source = null;
  let retryTimer = null;
  let retryMs = 1000;
  let closed = false;
  let flush = null; // { frame, timer } while a notification is scheduled

  const apply = {
    snapshot(d) {
      const next = serverDefaults();
      for (const key of Object.keys(next)) if (d[key] != null) next[key] = d[key];
      if (!Array.isArray(next.list)) next.list = [];
      next.summary = summaryOf(next.list) ?? next.summary;
      Object.assign(state, next);
    },
    utterance(u) {
      if (!u || u.id == null) return;
      state.list = upsert(state.list, u);
      if (u.kind === 'summary') state.summary = u.text;
    },
    roster(d) {
      if (d.participants) state.participants = d.participants;
    },
    baton(d) { state.baton = (d && d.holders) || []; },
    share(d) { state.share = d && d.src ? d : null; },
    scroll(d) { state.scroll = d || null; },
    interim(d) {
      if (!d || d.turn == null) return;
      const prev = state.interim[d.turn];
      const parts = { ...(prev ? prev.parts : {}), [d.part ?? 0]: d.text || '' };
      const text = Object.keys(parts).map(Number).sort((a, b) => a - b).map((k) => parts[k]).filter(Boolean).join(' ');
      const next = { ...state.interim, [d.turn]: { text, parts, at: d.at || null } };
      const turns = Object.keys(next);
      for (const t of turns.slice(0, Math.max(0, turns.length - MAX_TURNS))) delete next[t]; // oldest first
      state.interim = next;
    },
    meeting(m) { state.meeting = m; },
    summary(d) { state.summary = d.text ?? null; },
  };

  function schedule() {
    if (flush) return;
    const raf = env.raf || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16));
    const cancel = env.cancelRaf || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout);
    const run = () => {
      if (!flush) return;
      const f = flush;
      flush = null;
      cancel(f.frame);
      clearTimeout(f.timer);
      for (const fn of [...subs]) {
        try { fn(state); } catch (e) { console.error(e); }
      }
    };
    flush = { frame: raf(run), timer: setTimeout(run, FLUSH_FALLBACK_MS) };
  }

  function emit(type, data) {
    for (const fn of [...(handlers.get(type) || [])]) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }

  function handle(type, e) {
    let data;
    try { data = e.data ? JSON.parse(e.data) : {}; } catch (_) { return; }
    if (apply[type]) { apply[type](data); schedule(); }
    emit(type, data);
  }

  function setConnected(on) {
    if (state.connected === on) return;
    state.connected = on;
    schedule();
    emit(on ? 'connected' : 'disconnected', {});
  }

  function connect() {
    clearTimeout(retryTimer);
    if (source) source.close();
    const ES = env.EventSource || EventSource;
    source = new ES(url);
    for (const type of EVENT_TYPES) source.addEventListener(type, (e) => handle(type, e));
    source.onopen = () => { retryMs = 1000; setConnected(true); };
    source.onerror = () => {
      setConnected(false);
      // The browser reconnects by itself after a dropped connection, but not after an HTTP error
      // (for example a proxy answering 502 while the server restarts)
      if (source.readyState === CLOSED && !closed) {
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10000);
      }
    };
  }

  connect();

  return {
    state,
    subscribe(fn) {
      subs.add(fn);
      schedule(); // the new subscriber gets the current state on the next frame
      return () => subs.delete(fn);
    },
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    patch(fields) {
      Object.assign(state, fields);
      schedule();
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      if (source) source.close();
    },
  };
}
