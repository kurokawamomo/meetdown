// Push-to-talk and tap-to-toggle recording, from a button and from the Space key.
//   press down            -> onPress() at once (barge-in) and recording starts
//   released before holdMs -> 'toggled': keep recording; the next tap (down and up) stops and sends
//   released after holdMs  -> stop and send
// Beyond the contract: the `unlock` option (called on every gesture, so the page can unlock audio), the
// `enabled` option (a press that would start a recording is ignored while it returns false), `holdMs` may
// be a function, onChange(fn) receives (state, error), and closeMic() releases the microphone.

const DEFAULT_HOLD_MS = 300;
const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

const call = (fn, ...args) => {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (e) { console.error(e); }
};

// The timing rules, free of the DOM and the microphone so they can be tested.
// effects: { press(), start(), stop(send) }. States: 'idle' | 'holding' | 'toggled'.
export function createTalkMachine({ holdMs = DEFAULT_HOLD_MS, now = () => Date.now(), effects = {}, onChange = () => {}, enabled = () => true } = {}) {
  let state = 'idle';
  let error = null;
  let downAt = 0;
  let source = null; // the input that is down right now: 'key' | 'pointer'
  let stopTap = false; // toggled: the tap that will stop the recording is down

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
    } else if (state === 'toggled') {
      source = from;
      stopTap = true;
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
      set('idle');
      call(effects.stop, true);
    }
  }

  // The microphone could not start or stopped: back to idle, and the error goes out through onChange
  function fail(err) {
    source = null;
    stopTap = false;
    set('idle', err || new Error('recording failed'));
  }

  return { down, up, fail, get state() { return state; }, get error() { return error; } };
}

const browserMedia = () => ({
  getStream: () => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md || !md.getUserMedia) return Promise.reject(new Error('The microphone needs a secure page (https or localhost)'));
    return md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  },
  createRecorder: (stream) => new MediaRecorder(stream),
});

const isEditable = (el) => !!el && (TEXT_TAGS.has(el.tagName) || el.isContentEditable === true);
const defaultTyping = () => typeof document !== 'undefined' && isEditable(document.activeElement);

// onSend(blob, mime) gets the recording; onCancel() is called when nothing will be sent (the mic failed,
// or the recording was empty). Exactly one of them is called for every press.
export function createTalk({ holdMs = DEFAULT_HOLD_MS, onPress, onSend, onCancel, unlock, enabled, now, isTyping, media } = {}) {
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
    effects: { press: () => call(onPress), start, stop },
  });

  const live = (s) => s.getAudioTracks().some((t) => t.readyState === 'live');
  function ensureStream() {
    if (stream && live(stream)) return Promise.resolve(stream);
    stream = null;
    if (!opening) {
      opening = mic.getStream()
        .then((s) => { stream = s; watch(s); return s; })
        .finally(() => { opening = null; });
    }
    return opening;
  }
  // The system can take the microphone away (screen lock, another app)
  function watch(s) {
    for (const t of s.getAudioTracks()) {
      t.addEventListener('ended', () => {
        if (stream === s) stream = null;
        const a = cur;
        if (a && a.stream === s) { cur = null; finish(a, false); machine.fail(new Error('The microphone stopped')); }
      });
    }
  }

  // Every recording ends in exactly one of onSend and onCancel
  function conclude(a, blob) {
    if (a.done) return;
    a.done = true;
    if (blob) call(onSend, blob, blob.type);
    else call(onCancel);
  }
  function finish(a, send) {
    // the recorder only knows its mime type once it has started, so read it now
    const settle = () => conclude(a, send && a.chunks.length ? new Blob(a.chunks, { type: (a.rec && a.rec.mimeType) || a.chunks[0].type || '' }) : null);
    if (!a.rec || a.rec.state === 'inactive') return settle();
    a.rec.onstop = settle;
    try { a.rec.stop(); } catch (_) { settle(); }
  }

  function start() {
    const a = { id: ++attempts, rec: null, stream: null, chunks: [], ended: undefined, done: false };
    cur = a;
    ensureStream()
      .then((s) => {
        if (a.ended !== undefined) return conclude(a, null); // released before the microphone was ready
        a.stream = s;
        const rec = mic.createRecorder(s);
        a.rec = rec;
        rec.ondataavailable = (e) => { if (e.data && e.data.size) a.chunks.push(e.data); };
        rec.start();
      })
      .catch((err) => {
        if (cur === a) cur = null;
        conclude(a, null);
        if (attempts === a.id) machine.fail(err);
      });
  }

  function stop(send) {
    const a = cur;
    cur = null;
    if (!a) return;
    if (!a.rec) { a.ended = send; return; } // the microphone is still starting: start() concludes
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
    if (machine.state !== 'idle') return;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
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
