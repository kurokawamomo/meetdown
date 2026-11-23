// Audio diagnostics: the page reports what its audio is doing, so the cause of a silent Safari can be read
// afterwards from state/audio-diag.jsonl on the server. log(event, data) queues one event; a batch goes out
// shortly after (at once when the tab is hidden). A run of identical events is sent as one line with a count n.
//
// Every line: event, data, at (page clock, ISO), since (ms since the page opened), seq (number within this page),
// hidden (document.hidden), n and lastAt when it repeated. The server adds server (its clock), page and ua.
// Never throws: a failure to report must not touch the audio.

const FLUSH_MS = 2000;
const BATCH = 60; // the server accepts 100 per request
const QUEUE_MAX = 500;
const VOLATILE = new Set(['currentTime', 'rms', 'rmsMax', 'rmsMean']); // not part of "the same event"

const stable = (v) => JSON.stringify(v, (k, x) => (VOLATILE.has(k) ? undefined : x));

export function createDiag({ endpoint = '/api/audio-diag', env = {} } = {}) {
  const now = env.now || (() => Date.now());
  const page = env.page || Math.random().toString(36).slice(2, 10) + now().toString(36);
  const ua = env.ua !== undefined ? env.ua : (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const isHidden = env.hidden || (() => typeof document !== 'undefined' && document.hidden);
  const send = env.send || ((body) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).then((r) => r.ok));
  const later = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const stopLater = env.clearTimeout || ((id) => clearTimeout(id));
  const t0 = now();
  let seq = 0;
  let queue = [];
  let lastKey = null;
  let timer = null;
  let sending = false;
  let dropped = 0;

  function log(event, data = {}) {
    try {
      const at = now();
      const key = event + ' ' + stable(data);
      const last = queue[queue.length - 1];
      if (last && key === lastKey) {
        last.n = (last.n || 1) + 1;
        last.lastAt = new Date(at).toISOString();
        return;
      }
      lastKey = key;
      queue.push({ event, data, at: new Date(at).toISOString(), since: at - t0, seq: ++seq, hidden: !!isHidden() });
      if (queue.length > QUEUE_MAX) { queue.splice(0, queue.length - QUEUE_MAX); dropped++; }
      if (event === 'visibility' && data && data.hidden) flush();
      else if (queue.length >= BATCH) flush();
      else if (!timer) timer = later(flush, FLUSH_MS);
    } catch (_) {}
  }

  async function flush() {
    if (timer) { try { stopLater(timer); } catch (_) {} timer = null; }
    if (sending || !queue.length) return;
    sending = true;
    const events = queue.splice(0, BATCH);
    lastKey = null; // a line already taken is not extended
    try {
      if (dropped) { events.unshift({ event: 'diag-dropped', data: { n: dropped }, at: new Date(now()).toISOString(), since: now() - t0, seq: ++seq, hidden: !!isHidden() }); dropped = 0; }
      const okay = await send({ page, ua, events });
      if (okay === false) queue.unshift(...events.filter((e) => e.event !== 'diag-dropped')); // try again with the next batch
    } catch (_) {
      queue.unshift(...events.filter((e) => e.event !== 'diag-dropped'));
    } finally {
      sending = false;
      if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
      if (queue.length && !timer) timer = later(flush, FLUSH_MS);
    }
  }

  return { log, flush, get page() { return page; } };
}
