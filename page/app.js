// meetdown page. Records only while the button is held, plays AI voices in arrival order, and stops them when pressed.
const $ = (s) => document.querySelector(s);
let ui = {};
let overlap = 1;
let roster = { partner: null, participants: [] };
const silenced = new Set(); // cut or dropped utterances; their late audio is not played

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
const note = (t) => { $('#status').textContent = t || ''; };
const labelOf = (n) => (n === 'human' ? ui.you : n === 'system' ? ui.meeting : (roster.participants.find((p) => p.name === n) || {}).label || n);

// ---- Rendering ----
function applyUi(lang) {
  document.documentElement.lang = lang;
  $('#talk').textContent = ui.talk;
  $('#text').placeholder = ui.placeholder;
  $('#send').textContent = ui.send;
}
function renderPeople() {
  $('#people').innerHTML = '';
  for (const p of roster.participants) {
    const b = document.createElement('button');
    b.className = 'who' + (p.name === roster.partner ? ' partner' : '') + (p.status === 'absent' ? ' absent' : '');
    b.textContent = p.label || p.name;
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = ui[p.status] || p.status;
    b.append(st);
    b.onclick = () => post('/api/partner', { name: p.name });
    $('#people').append(b);
  }
}
function renderUtterance(u) {
  let el = document.getElementById('u' + u.id);
  const stick = $('#list').scrollTop + $('#list').clientHeight >= $('#list').scrollHeight - 40;
  if (!el) { el = document.createElement('div'); el.id = 'u' + u.id; $('#list').append(el); }
  el.className = 'u ' + (u.from === 'human' ? 'human' : u.kind === 'note' ? 'note' : 'ai');
  const to = u.to && u.to.length ? ' → ' + u.to.map(labelOf).join(', ') : '';
  el.innerHTML = '<div class="meta"></div><div class="body"></div>';
  el.querySelector('.meta').textContent = labelOf(u.from) + to;
  el.querySelector('.body').textContent = u.text;
  if (['cut', 'dropped', 'error'].includes(u.play)) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = ui[u.play];
    el.querySelector('.meta').append(t);
  }
  if (stick) $('#list').scrollTop = $('#list').scrollHeight;
}

// ---- Playback: in arrival order; when the speaker changes, the next voice may start `overlap` seconds early ----
let ctx = null;
const waiting = []; // not scheduled yet
const active = [];  // scheduled, including ones set to start later
let nextAt = 0, lastFrom = null, pumping = false, pressing = false;

function unlockAudio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
}
const decode = (buf) => new Promise((ok, ng) => ctx.decodeAudioData(buf, ok, ng));

function enqueue(a) {
  if (silenced.has(a.id)) return;
  a.buf = fetch(a.url).then((r) => r.arrayBuffer());
  waiting.push(a);
  pump();
}
async function pump() {
  if (pumping || pressing || !ctx || !waiting.length) return;
  pumping = true;
  const a = waiting[0];
  let buf = null;
  try { buf = await decode(await a.buf); } catch (_) {}
  if (waiting[0] !== a || pressing) { pumping = false; return pump(); }
  waiting.shift();
  if (buf && !silenced.has(a.id)) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime, nextAt - (lastFrom && lastFrom !== a.from ? overlap : 0));
    src.start(at);
    const item = { id: a.id, seq: a.seq, src, start: at, end: at + buf.duration };
    active.push(item);
    if (a.seq === 0) post('/api/play', { id: a.id, state: 'playing' });
    src.onended = () => {
      const i = active.indexOf(item);
      if (i >= 0) active.splice(i, 1);
      if (a.last && !silenced.has(a.id)) post('/api/play', { id: a.id, state: 'done' });
    };
    nextAt = item.end + (a.gap || 0);
    lastFrom = a.from;
  }
  pumping = false;
  pump();
}
// Stop everything. Returns what was playing (utterance and sentence) and what was waiting
function stopAudio() {
  const now = ctx ? ctx.currentTime : 0;
  const playing = active.find((x) => x.start <= now && now < x.end) || null;
  for (const x of active.splice(0)) { silenced.add(x.id); try { x.src.onended = null; x.src.stop(); } catch (_) {} }
  const pending = waiting.splice(0).map((x) => x.id);
  pending.forEach((id) => silenced.add(id));
  nextAt = 0;
  lastFrom = null;
  return { playing: playing && { id: playing.id, seq: playing.seq }, pending: [...new Set(pending)] };
}

// ---- Push to talk ----
let stream = null, rec = null, chunks = [];
async function press() {
  if (pressing) return;
  pressing = true;
  unlockAudio();
  $('#talk').classList.add('on');
  post('/api/press', stopAudio());
  try {
    stream = stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    note(ui.micError + e.message);
    pressing = false;
    $('#talk').classList.remove('on');
    return post('/api/cancel', {});
  }
  if (!pressing) return; // released while the microphone was starting; release() already cancelled
  chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start();
}
function release() {
  if (!pressing) return;
  pressing = false;
  $('#talk').classList.remove('on');
  if (!rec || rec.state !== 'recording') { post('/api/cancel', {}); return pump(); }
  const r = rec;
  r.onstop = async () => {
    note(ui.transcribing);
    try {
      const res = await fetch('/api/talk', { method: 'POST', headers: { 'Content-Type': r.mimeType || 'application/octet-stream' }, body: new Blob(chunks, { type: r.mimeType }) });
      const d = await res.json();
      note(d.error || (d.text ? '' : ui.unheard));
    } catch (e) { note(ui.sendError + e.message); }
    pump();
  };
  r.stop();
}

const talk = $('#talk');
talk.addEventListener('pointerdown', (e) => { e.preventDefault(); talk.setPointerCapture(e.pointerId); press(); });
talk.addEventListener('pointerup', release);
talk.addEventListener('pointercancel', release);
talk.addEventListener('contextmenu', (e) => e.preventDefault());
const typing = () => document.activeElement && document.activeElement.tagName === 'INPUT';
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !typing()) { e.preventDefault(); if (!e.repeat) press(); } });
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing()) { e.preventDefault(); release(); } });
$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  const t = $('#text').value.trim();
  if (t) post('/api/text', { text: t });
  $('#text').value = '';
});
document.addEventListener('pointerdown', unlockAudio, { once: true });

// ---- Server events ----
const es = new EventSource('/events');
es.addEventListener('snapshot', (e) => {
  const d = JSON.parse(e.data);
  ui = d.ui;
  overlap = d.overlap;
  roster = { partner: d.partner, participants: d.participants };
  applyUi(d.lang);
  document.title = 'meetdown ' + d.meetingId;
  $('#list').innerHTML = '';
  for (const u of d.list) renderUtterance(u);
  renderPeople();
});
es.addEventListener('utterance', (e) => {
  const u = JSON.parse(e.data);
  if (u.play === 'cut' || u.play === 'dropped') silenced.add(u.id);
  renderUtterance(u);
});
es.addEventListener('participants', (e) => { roster = JSON.parse(e.data); renderPeople(); });
es.addEventListener('audio', (e) => enqueue(JSON.parse(e.data)));
es.addEventListener('stop', () => { stopAudio(); });
es.addEventListener('note', (e) => note(JSON.parse(e.data).text));
es.onerror = () => note(ui.reconnecting);
es.onopen = () => note('');
