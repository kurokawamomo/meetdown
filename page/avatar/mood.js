// Mood selection for avatars. Pure functions plus a small signal tracker. No DOM access.
//
// moodOf() turns what the page knows about a participant into one of six moods.
// createMoodTracker() remembers the short windows opened by `signal` events
// (called / cut -> surprised for 1.2 s, shared -> nodding for 1.5 s).

export const MOODS = ['idle', 'speaking', 'thinking', 'listening', 'surprised', 'away'];
export const SURPRISE_MS = 1200;
export const NOD_MS = 1500;

// Priority: speaking > surprised > listening > thinking > idle.
// `away` (status 'absent') is the exception to "idle is the fallback": an absent session cannot react, so it
// overrides surprised / listening / thinking. Only an audible voice (speaking) still wins over it.
// `now`, `surprisedUntil` and `nodUntil` share one clock (milliseconds, Date.now() by default).
export function moodOf({ status, speaking = false, listening = false, surprisedUntil = 0, nodUntil = 0, now = Date.now() } = {}) {
  if (speaking) return 'speaking';
  if (status === 'absent') return 'away';
  if (surprisedUntil > now) return 'surprised';
  if (listening || nodUntil > now) return 'listening';
  if (status === 'busy') return 'thinking';
  return 'idle';
}

// tracker.signal({ name, kind })      kind: 'called' | 'cut' (surprise window) or 'shared' (nod window). Also signal(name, kind).
// tracker.windowsFor(name)            -> { surprisedUntil, nodUntil } (0 when no window); spread it into moodOf().
// tracker.moodFor(name, state)        -> mood, state = { status, speaking, listening }; windows and clock are filled in.
// tracker.onChange(fn)                fn(name) runs when a window opens and again just after it closes, so a caller can
//                                     re-run moodOf and call setMood without polling. Returns an unsubscribe function.
// tracker.forget(name)                drops one name (or everything without an argument).
export function createMoodTracker({ now = () => Date.now(), surpriseMs = SURPRISE_MS, nodMs = NOD_MS } = {}) {
  const byName = new Map();
  const timers = new Map();
  const listeners = new Set();

  const notify = (name) => { for (const fn of [...listeners]) fn(name); };
  const slot = (name) => {
    let w = byName.get(name);
    if (!w) { w = { surprisedUntil: 0, nodUntil: 0 }; byName.set(name, w); }
    return w;
  };
  function closeLater(name, key, until) {
    const k = name + '\u0000' + key;
    clearTimeout(timers.get(k));
    const t = setTimeout(() => { timers.delete(k); notify(name); }, Math.max(0, until - now()) + 30);
    if (t && typeof t.unref === 'function') t.unref();
    timers.set(k, t);
  }

  function signal(evt, kindArg) {
    const name = typeof evt === 'string' ? evt : evt && evt.name;
    const kind = typeof evt === 'string' ? kindArg : evt && evt.kind;
    if (!name) return false;
    const t = now();
    if (kind === 'called' || kind === 'cut') {
      const w = slot(name);
      w.surprisedUntil = t + surpriseMs;
      closeLater(name, 's', w.surprisedUntil);
    } else if (kind === 'shared') {
      const w = slot(name);
      w.nodUntil = t + nodMs;
      closeLater(name, 'n', w.nodUntil);
    } else {
      return false;
    }
    notify(name);
    return true;
  }

  function windowsFor(name) {
    const w = byName.get(name);
    return w ? { surprisedUntil: w.surprisedUntil, nodUntil: w.nodUntil } : { surprisedUntil: 0, nodUntil: 0 };
  }

  function moodFor(name, state = {}) {
    return moodOf({ ...state, ...windowsFor(name), now: now() });
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function forget(name) {
    const drop = (n) => {
      byName.delete(n);
      for (const k of [...timers.keys()]) {
        if (k.startsWith(n + '\u0000')) { clearTimeout(timers.get(k)); timers.delete(k); }
      }
    };
    if (name === undefined) { for (const n of [...byName.keys()]) drop(n); } else { drop(name); }
  }

  return { signal, windowsFor, moodFor, onChange, forget };
}
