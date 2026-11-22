// stage.js: the tile grid. One tile per participant (kept across renders: only classes and attributes change),
// a baton badge on the tiles that hold the baton, three balloon levels per tile (thought, murmur, speech),
// a hover toolbar with "remove" (asks once), and Meet's presenting layout while store.state.share is set
// (big shared area, tiles in a strip). Everything it needs is read from store.state.
import { moodOf, createMoodTracker } from './avatar/mood.js';
import { distinctLetters } from './avatar/meet.js';

const MIN_TILE_H = 120;
const MIN_ASPECT = 0.5; // tiles may be tall (portrait) down to this width / height ...
const MAX_ASPECT = 1.8; // ... and wide up to this
const TOOLS_MS = 4000;
const SPEAKING_SCAN = 60;
const MURMUR_MS = 6000;
const SPEECH_LINES = 3;
const SPEECH_IDLE_MS = 30000; // safety net: a speech balloon nobody cleared turns into its afterglow
const fill = (str, vars) => String(str).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

const ICON = {
  baton: '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>',
  dismiss: '<path d="M14 8c0-2.21-1.79-4-4-4S6 5.79 6 8s1.79 4 4 4 4-1.79 4-4zm3 6v-2h6v2h-6zM2 18v2h16v-2c0-2.66-5.33-4-8-4s-8 1.34-8 4z"/>',
  group: '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>',
  present: '<path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>',
};
ICON.pin = '<path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/>';
ICON.close = '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>';
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;

function div(cls, html) {
  const e = document.createElement('div');
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const hueOf = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
};

// Meet's dynamic layouts: try every column count and keep the one with the biggest tiles, with tile shapes held
// between tall and wide and a small penalty for half-empty rows and for shapes far from the preferred one.
// A wide window gives 3 tiles as one row of portrait tiles, 4 as 2 x 2, 10 as 5 x 2; a phone gives 2 in a column
// and 4 as 2 x 2.
function fit(n, W, H, gap) {
  const target = W < H * 0.9 ? 0.7 : 1;
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let tw = (W - (cols - 1) * gap) / cols;
    let th = (H - (rows - 1) * gap) / rows;
    if (tw / th > MAX_ASPECT) tw = th * MAX_ASPECT;
    else if (tw / th < MIN_ASPECT) th = tw / MIN_ASPECT;
    const shape = Math.min(tw / th, target) / Math.max(tw / th, target);
    const score = tw * th * shape * (n / (cols * rows));
    if (!best || score > best.score * 1.0001) best = { cols, tw, th, score };
  }
  return { cols: best.cols, tw: Math.max(Math.floor(best.tw), 80), th: Math.max(Math.floor(best.th), MIN_TILE_H) };
}

// Who is audible: state.speaking when the page keeps it (player.onSpeaking -> store.patch), otherwise
// the utterances whose `play` field the server set to 'playing'
function speakingNames(s) {
  if (s.speaking) return new Set(s.speaking);
  const list = s.list || [];
  const out = new Set();
  for (let i = list.length - 1, seen = 0; i >= 0 && seen < SPEAKING_SCAN; i--, seen++) {
    if (list[i].kind === 'say' && list[i].play === 'playing') out.add(list[i].from);
  }
  return out;
}

const holdersOf = (b) => new Set(Array.isArray(b) ? b : (b && b.holders) || []);

export function createStage(root, { store, onDismiss, onShareClose, avatarFor, talk } = {}) {
  root.classList.add('stage');
  const empty = div('stage-empty', icon('group'));
  const grid = div('grid');

  // presenting layout: the shared content (iframe or img) with a header pill and an optional caption
  const shareHead = div('pres-head', icon('present') + '<span class="pres-title"></span>');
  const shareTitle = shareHead.lastChild;
  // Meet's controls on the shared content: unpin (it becomes one tile among the others) and close (for everyone)
  const sharePin = document.createElement('button');
  sharePin.type = 'button';
  sharePin.className = 'pres-btn pres-pin';
  sharePin.innerHTML = icon('pin');
  const shareClose = document.createElement('button');
  shareClose.type = 'button';
  shareClose.className = 'pres-btn pres-close';
  shareClose.innerHTML = icon('close');
  shareHead.append(sharePin, shareClose);
  let pinned = true; // this viewer's choice; a new share is pinned again
  let pinnedFor = null;
  sharePin.addEventListener('click', (e) => { e.stopPropagation(); pinned = !pinned; render(); });
  shareClose.addEventListener('click', (e) => { e.stopPropagation(); if (onShareClose) onShareClose(); });
  const shareFrame = div('pres-frame');
  const shareCaption = div('pres-caption');
  const shareEl = div('pres');
  shareEl.hidden = true;
  shareEl.append(shareHead, shareFrame, shareCaption);
  root.append(empty, shareEl, grid);

  const tiles = new Map(); // participant name -> tile record
  const bal = new Map(); // participant name -> balloon data { thought, murmur, murmurTimer, speech: [{id,text}], speechTimer }
  const tracker = createMoodTracker(); // surprise and nod windows; calls back when one opens and when it closes
  let raf = 0;
  let layoutKey = '';
  let lastCount = -1;
  let relayoutTimer = 0;
  let toolsTimer = 0;
  let pointerType = 'mouse';
  let lineId = 0;

  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };
  const uiText = (k) => {
    const ui = (store.state && store.state.ui) || {};
    return Object.keys(ui).length ? ui[k] ?? k : '';
  };

  // ---- tile construction ----
  function makeTile(p) {
    const el = div('tile');
    el.dataset.name = p.name;
    el.setAttribute('role', 'group'); // the toolbar button is the keyboard and screen-reader way in
    const glow = div('tile-glow');
    glow.setAttribute('aria-hidden', 'true');
    const bg = div('tile-bg');
    bg.append(glow);
    const avatarHost = div('tile-avatar');
    const nameEl = document.createElement('span');
    nameEl.className = 'label-name';
    const chairEl = document.createElement('span');
    chairEl.className = 'label-chair';
    const subEl = document.createElement('span');
    subEl.className = 'label-sub';
    const label = div('label', '<span class="label-voice" aria-hidden="true"><i></i><i></i><i></i></span>');
    label.append(nameEl, chairEl, subEl);
    const baton = div('baton-badge', icon('baton'));
    const toolbar = div('toolbar');
    toolbar.setAttribute('role', 'toolbar');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'tb tb-dismiss';
    dismiss.innerHTML = icon('dismiss');
    toolbar.append(dismiss);
    // one balloon is shown at a time: speech over murmur over thought
    const thoughtText = document.createElement('span');
    thoughtText.className = 'bln-text';
    const thought = div('bln bln-thought');
    thought.append(thoughtText, div('bln-dots', '<b></b><b></b>'));
    const murmurText = document.createElement('span');
    murmurText.className = 'bln-text';
    const murmur = div('bln bln-murmur');
    murmur.append(murmurText);
    const lines = div('sp-lines');
    const speech = div('bln bln-speech');
    speech.append(lines);
    const balloons = div('balloons');
    balloons.append(thought, murmur, speech);
    const clip = div('tile-clip');
    clip.append(bg, avatarHost, balloons, div('voice', '<i></i><i></i><i></i>'), baton, label, toolbar);
    el.append(clip);
    return { name: p.name, el, glow, avatarHost, avatar: null, avatarKey: null, nameEl, chairEl, subEl, baton, dismiss, balloons, thoughtText, murmurText, lines, view: {} };
  }

  function dropAvatar(rec) {
    if (rec.avatar && typeof rec.avatar.destroy === 'function') rec.avatar.destroy();
    rec.avatar = null;
  }

  // avatarFor is called once per participant and kept; it is called again only when the look changes
  function mountAvatar(rec, p, letter) {
    if (letter && !(p.look && p.look.letter)) p = { ...p, look: { ...(p.look || {}), letter } };
    const key = JSON.stringify(p.look || {});
    if (rec.avatarKey === key) return;
    rec.avatarKey = key;
    dropAvatar(rec);
    let made = null;
    try { made = avatarFor ? avatarFor(p) : null; } catch (e) { console.error('avatarFor failed', e); }
    let node = made && (made instanceof Element ? made : made.el);
    if (!node) {
      node = div('avatar-fallback');
      node.style.setProperty('--hue', hueOf(p.name));
      node.textContent = Array.from(p.label || p.name)[0] || '';
    }
    rec.avatarHost.replaceChildren(node);
    rec.glow.replaceChildren(node.cloneNode(true)); // the tile background is a blurred, enlarged copy of the avatar
    rec.avatar = made && !(made instanceof Element) ? made : null;
    rec.view.mood = null;
  }

  // ---- per-tile updates: write to the DOM only when a value changed ----
  const setFlag = (rec, cls, on) => {
    if (rec.view[cls] === on) return;
    rec.view[cls] = on;
    rec.el.classList.toggle(cls, on);
  };
  const setText = (rec, key, node, value) => {
    if (rec.view[key] === value) return;
    rec.view[key] = value;
    node.textContent = value;
  };
  const setAttr = (rec, key, node, attr, value) => {
    if (rec.view[key] === value) return;
    rec.view[key] = value;
    node.setAttribute(attr, value);
  };

  // ---- balloons ----
  const balOf = (name) => {
    let b = bal.get(name);
    if (!b) {
      b = { thought: '', murmur: '', murmurTimer: 0, speech: [], glow: false, speechTimer: 0 };
      bal.set(name, b);
    }
    return b;
  };

  function paintBalloons(rec) {
    const b = bal.get(rec.name);
    const thought = b ? b.thought : '';
    const murmur = b ? b.murmur : '';
    const speech = b ? b.speech : [];
    // live speech, murmur, the afterglow of the last speech (faint, kept after the speaker finished), thought
    const glow = !!(b && b.glow && speech.length);
    const show = speech.length && !glow ? 'speech' : murmur ? 'murmur' : glow ? 'speech' : thought ? 'thought' : '';
    if (rec.view.glow !== glow) {
      rec.view.glow = glow;
      if (glow) rec.balloons.dataset.glow = '1';
      else delete rec.balloons.dataset.glow;
    }
    if (rec.view.show !== show) {
      rec.view.show = show;
      if (show) rec.balloons.dataset.show = show;
      else delete rec.balloons.dataset.show;
    }
    setText(rec, 'thought', rec.thoughtText, thought);
    setText(rec, 'murmur', rec.murmurText, murmur);
    // speech lines are kept by id so a new line animates in and the older ones stay put and fade
    const have = new Map([...rec.lines.children].map((c) => [Number(c.dataset.id), c]));
    for (const [id, node] of have) if (!speech.some((l) => l.id === id)) node.remove();
    for (const l of speech) {
      if (have.has(l.id)) continue;
      const p = document.createElement('p');
      p.className = 'sp-line';
      p.dataset.id = String(l.id);
      p.textContent = l.text;
      rec.lines.append(p);
    }
  }
  const paintBalloonsOf = (name) => { const rec = tiles.get(name); if (rec) paintBalloons(rec); };

  function showThought(name, text) {
    balOf(name).thought = String(text || '').trim();
    paintBalloonsOf(name);
  }
  function showMurmur(name, text) {
    const b = balOf(name);
    clearTimeout(b.murmurTimer);
    b.murmur = String(text || '').trim();
    if (b.murmur) b.murmurTimer = setTimeout(() => { b.murmur = ''; paintBalloonsOf(name); }, MURMUR_MS);
    paintBalloonsOf(name);
  }
  function showSpeech(name, text) {
    const b = balOf(name);
    const line = String(text || '').trim();
    if (!line) return;
    if (b.glow) { b.speech = []; b.glow = false; } // the live balloon replaces the afterglow
    b.speech = [...b.speech, { id: ++lineId, text: line }].slice(-SPEECH_LINES);
    clearTimeout(b.speechTimer);
    b.speechTimer = setTimeout(() => clearSpeech(name), SPEECH_IDLE_MS);
    paintBalloonsOf(name);
  }
  function clearSpeech(name) {
    const b = bal.get(name);
    if (!b) return;
    clearTimeout(b.speechTimer);
    b.glow = b.speech.length > 0; // the text stays as a faint afterglow
    paintBalloonsOf(name);
  }

  function update(rec, p, ctx) {
    const { t, now } = ctx;
    const label = p.label || p.name;
    const sub = p.status === 'busy' || p.status === 'absent' ? t(p.status) : '';
    const holds = ctx.baton.has(p.name);
    mountAvatar(rec, p, ctx.letters[p.name]);
    setText(rec, 'label', rec.nameEl, label);
    setText(rec, 'chair', rec.chairEl, p.chair ? t('chair') : '');
    setText(rec, 'sub', rec.subEl, sub);
    setAttr(rec, 'aria', rec.el, 'aria-label', sub ? `${label}, ${sub}` : label);
    setAttr(rec, 'baton-tip', rec.baton, 'title', t('baton'));
    setFlag(rec, 'is-baton', holds);
    setFlag(rec, 'is-speaking', ctx.speaking.has(p.name));
    setFlag(rec, 'is-away', p.status === 'absent');
    setAttr(rec, 'tip-dismiss', rec.dismiss, 'aria-label', t('dismiss'));
    setAttr(rec, 'title-dismiss', rec.dismiss, 'title', t('dismiss'));
    paintBalloons(rec);

    const mood = moodOf({
      status: p.status,
      speaking: ctx.speaking.has(p.name),
      listening: ctx.talking && holds,
      ...tracker.windowsFor(p.name),
      now,
    });
    if (mood !== rec.view.mood) {
      rec.view.mood = mood;
      rec.el.dataset.mood = mood;
      if (rec.avatar && typeof rec.avatar.setMood === 'function') rec.avatar.setMood(mood);
    }
  }

  // ---- layout ----
  function applyLayout() {
    const n = tiles.size + (shareEl.classList.contains('pres-tile') && !shareEl.hidden ? 1 : 0);
    const W = root.clientWidth;
    const H = root.clientHeight;
    if (n !== lastCount) {
      if (lastCount > 0 && n > 0 && !root.classList.contains('presenting')) {
        root.classList.add('relayout');
        clearTimeout(relayoutTimer);
        relayoutTimer = setTimeout(() => root.classList.remove('relayout'), 320);
      }
      lastCount = n;
    }
    root.dataset.count = String(n);
    if (root.classList.contains('presenting')) { layoutKey = ''; return; } // the strip is sized by CSS
    if (!n || !W || !H) return;
    const { cols, tw, th } = fit(n, W, H, parseFloat(getComputedStyle(grid).columnGap) || 12);
    const key = `${cols}/${tw}/${th}`;
    if (key === layoutKey) return;
    layoutKey = key;
    root.style.setProperty('--tw', tw + 'px');
    root.style.setProperty('--th', th + 'px');
    root.dataset.cols = String(cols);
  }

  // ---- presenting: the shared content ----
  let media = null; // { kind: 'image'|'frame', id, el, src }
  let lastTop = 0;
  let lastScroll = null;

  const bust = (sh) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(sh.src) || sh.src.startsWith('//')) return sh.src; // somebody else's page: do not change its address
    return sh.src + (sh.src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(sh.version ?? 0);
  };
  const external = (src) => /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//');

  function scrollFrame(percent, smooth) {
    if (!media || media.kind !== 'frame') return;
    try {
      const win = media.el.contentWindow;
      const doc = media.el.contentDocument;
      if (!win || !doc || !doc.documentElement) return;
      const max = Math.max(0, doc.documentElement.scrollHeight - win.innerHeight);
      win.scrollTo({ top: (max * Math.min(100, Math.max(0, Number(percent) || 0))) / 100, behavior: smooth ? 'smooth' : 'auto' });
    } catch (_) { /* a cross-origin page or a pdf viewer cannot be scrolled from here */ }
  }
  function restoreTop() {
    try { media.el.contentWindow.scrollTo(0, lastTop); } catch (_) { /* cross-origin */ }
  }
  function makeMedia(sh) {
    if (sh.kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      return { kind: 'image', id: sh.id, el: img, src: '' };
    }
    const f = document.createElement('iframe');
    f.title = 'share';
    f.referrerPolicy = 'no-referrer';
    if (external(sh.src)) f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups'); // same-origin files stay scrollable
    const m = { kind: 'frame', id: sh.id, el: f, src: '', ext: external(sh.src) };
    f.addEventListener('load', () => {
      const sc = store.state && store.state.scroll;
      if (sc && sc.percent != null) scrollFrame(sc.percent, false);
      else restoreTop();
    });
    return m;
  }

  function syncShare(s, t) {
    const sh = s.share && s.share.src ? s.share : null;
    if (sh && sh.id !== pinnedFor) { pinnedFor = sh.id; pinned = true; }
    const asTile = !!sh && !pinned;
    root.classList.toggle('presenting', !!sh && pinned);
    shareEl.classList.toggle('pres-tile', asTile);
    if (asTile && grid.lastChild !== shareEl) grid.append(shareEl); // last, so the participants keep their places
    if (!asTile && shareEl.parentNode !== root) root.insertBefore(shareEl, grid);
    shareEl.hidden = !sh;
    const pinLabel = t(pinned ? 'unpinShare' : 'pinShare');
    if (sharePin.title !== pinLabel) { sharePin.title = pinLabel; sharePin.setAttribute('aria-label', pinLabel); }
    sharePin.classList.toggle('off', !pinned);
    const closeLabel = t('stopShare');
    if (shareClose.title !== closeLabel) { shareClose.title = closeLabel; shareClose.setAttribute('aria-label', closeLabel); }
    if (!sh) {
      if (media) { media = null; shareFrame.replaceChildren(); }
      lastScroll = null;
      return;
    }
    const who = (s.participants || []).find((p) => p.name === sh.by);
    const title = fill(t('sharing'), { name: (who && (who.label || who.name)) || sh.by || '', by: sh.by || '', label: sh.caption || '' });
    if (shareTitle.textContent !== title) shareTitle.textContent = title;
    const caption = sh.caption || '';
    if (shareCaption.textContent !== caption) shareCaption.textContent = caption;
    shareCaption.hidden = !caption;
    const kind = sh.kind === 'image' ? 'image' : 'frame';
    if (!media || media.kind !== kind || media.id !== sh.id || (kind === 'frame' && media.ext !== external(sh.src))) {
      media = makeMedia(sh);
      shareFrame.replaceChildren(media.el);
      shareFrame.dataset.kind = kind;
    }
    const src = bust(sh);
    if (media.src !== src) {
      if (media.kind === 'frame') {
        try { lastTop = media.el.contentWindow.scrollY || 0; } catch (_) { lastTop = 0; }
      }
      media.src = src;
      media.el.src = src;
    }
    if (s.scroll !== lastScroll) {
      lastScroll = s.scroll;
      if (s.scroll && s.scroll.percent != null) scrollFrame(s.scroll.percent, true);
    }
  }

  // ---- render ----
  function render() {
    raf = 0;
    const s = store.state || {};
    const uiMap = s.ui || {};
    const hasUi = Object.keys(uiMap).length > 0;
    const t = (k) => (hasUi ? uiMap[k] ?? k : '');
    const people = s.participants || [];
    const ctx = {
      t,
      now: Date.now(),
      baton: holdersOf(s.baton),
      speaking: speakingNames(s),
      talking: !!talk && !!talk.state && talk.state !== 'idle',
      letters: distinctLetters(people),
    };

    const seen = new Set();
    people.forEach((p, i) => {
      seen.add(p.name);
      let rec = tiles.get(p.name);
      if (!rec) {
        rec = makeTile(p);
        tiles.set(p.name, rec);
      }
      update(rec, p, ctx);
      if (grid.children[i] !== rec.el) grid.insertBefore(rec.el, grid.children[i] || null);
    });
    for (const [name, rec] of tiles) {
      if (seen.has(name)) continue;
      dropAvatar(rec);
      rec.el.remove();
      tiles.delete(name);
      tracker.forget(name);
      const b = bal.get(name);
      if (b) { clearTimeout(b.murmurTimer); clearTimeout(b.speechTimer); bal.delete(name); }
    }
    syncShare(s, t);
    applyLayout();
  }

  store.on('signal', (sig) => tracker.signal(sig));
  const offTracker = tracker.onChange(schedule);

  // ---- dismiss: asks once ----
  const overlays = document.getElementById('overlays') || document.body;
  const confirmText = div('confirm-text');
  confirmText.id = 'confirm-text';
  const confirmNo = document.createElement('button');
  confirmNo.type = 'button';
  confirmNo.className = 'confirm-btn';
  const confirmYes = document.createElement('button');
  confirmYes.type = 'button';
  confirmYes.className = 'confirm-btn confirm-yes';
  const confirmActions = div('confirm-actions');
  confirmActions.append(confirmNo, confirmYes);
  const confirmBox = div('confirm');
  confirmBox.setAttribute('role', 'alertdialog');
  confirmBox.setAttribute('aria-modal', 'true');
  confirmBox.setAttribute('aria-labelledby', 'confirm-text');
  confirmBox.append(confirmText, confirmActions);
  const confirmScrim = div('confirm-scrim');
  confirmScrim.append(confirmBox);
  overlays.append(confirmScrim);
  let pendingDismiss = null;

  function closeConfirm() {
    pendingDismiss = null;
    confirmScrim.classList.remove('show');
  }
  function askDismiss(name) {
    const p = (store.state.participants || []).find((x) => x.name === name);
    pendingDismiss = name;
    confirmText.textContent = fill(uiText('dismissConfirm'), { name: (p && (p.label || p.name)) || name });
    confirmNo.textContent = uiText('dismissNo');
    confirmYes.textContent = uiText('dismissYes');
    confirmScrim.classList.add('show');
    confirmNo.focus({ preventScroll: true });
  }
  confirmYes.addEventListener('click', () => {
    const name = pendingDismiss;
    closeConfirm();
    confirmYes.blur();
    if (name && onDismiss) onDismiss(name);
  });
  confirmNo.addEventListener('click', () => { closeConfirm(); confirmNo.blur(); });
  confirmScrim.addEventListener('pointerdown', (e) => { if (e.target === confirmScrim) closeConfirm(); });
  const onKey = (e) => { if (e.key === 'Escape' && pendingDismiss) closeConfirm(); };
  document.addEventListener('keydown', onKey);

  // ---- input ----
  const hideTools = () => {
    clearTimeout(toolsTimer);
    for (const rec of tiles.values()) rec.el.classList.remove('has-tools');
  };
  const showTools = (el) => {
    hideTools();
    el.classList.add('has-tools');
    toolsTimer = setTimeout(hideTools, TOOLS_MS);
  };

  const onPointerDown = (e) => {
    pointerType = e.pointerType || 'mouse';
    if (!(e.target instanceof Element) || !e.target.closest('.tile')) hideTools();
  };
  document.addEventListener('pointerdown', onPointerDown, true);

  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const btn = e.target.closest('.tb');
    if (btn) {
      if (pointerType !== 'mouse') showTools(tile);
      askDismiss(tile.dataset.name);
      if (e.detail) btn.blur(); // a focused button would also react to Space, which is the talk key
      return;
    }
    if (pointerType !== 'mouse') showTools(tile); // touch: a tap floats the toolbar
  });

  // ---- wiring ----
  const unsubscribe = store.subscribe(schedule);
  if (talk && typeof talk.onChange === 'function') talk.onChange(schedule);
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(applyLayout);
    ro.observe(root);
  } else {
    window.addEventListener('resize', applyLayout);
  }
  schedule();

  return {
    render: schedule,
    showThought,
    showMurmur,
    showSpeech,
    clearSpeech,
    destroy() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', applyLayout);
      if (ro) ro.disconnect();
      if (typeof unsubscribe === 'function') unsubscribe();
      offTracker();
      for (const b of bal.values()) { clearTimeout(b.murmurTimer); clearTimeout(b.speechTimer); }
      confirmScrim.remove();
      clearTimeout(toolsTimer);
      clearTimeout(relayoutTimer);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
