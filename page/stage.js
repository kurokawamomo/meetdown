// stage.js: the tile grid. One tile per participant (kept across renders: only classes and attributes change),
// a red down-triangle on focused tiles, a small faded one on loose matches, and a floating toolbar
// (focus, aside, dismiss). Everything it needs is read from store.state.
import { moodOf, createMoodTracker } from './avatar/mood.js';

const MIN_TILE_H = 120;
const MIN_ASPECT = 0.5; // tiles may be tall (portrait) down to this width / height ...
const MAX_ASPECT = 1.8; // ... and wide up to this
const TOOLS_MS = 4000;
const SPEAKING_SCAN = 60;

const ICON = {
  aside: '<path d="M9 9m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0M16.76 5.36l-1.68 1.69c.84 1.18.84 2.71 0 3.89l1.68 1.69c2.02-2.02 2.02-5.07 0-7.27zM20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9-3.89 3.91-9.95 0-14zM9 13c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  focus: '<path d="M5.4 6.5h13.2c1.2 0 1.9 1.3 1.2 2.3l-6.6 9.6c-.6.9-1.8.9-2.4 0L4.2 8.8c-.7-1 0-2.3 1.2-2.3z"/>',
  dismiss: '<path d="M14 8c0-2.21-1.79-4-4-4S6 5.79 6 8s1.79 4 4 4 4-1.79 4-4zm3 6v-2h6v2h-6zM2 18v2h16v-2c0-2.66-5.33-4-8-4s-8 1.34-8 4z"/>',
  group: '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
// Zelda-style target arrow: a rounded down-pointing triangle with a lighter facet on the left
const TRIANGLE = '<svg viewBox="0 0 48 44" aria-hidden="true" focusable="false"><path d="M7 6h34L24 36z" fill="currentColor" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/><path d="M12 9.5h11v19.5z" fill="#fff" opacity=".3"/></svg>';

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

// Loose matches belong to the latest human utterance; a newer one replaces them
function maybeNames(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const u = list[i];
    if (u.from === 'human' && (u.kind === 'voice' || u.kind === 'text')) return new Set(u.maybe || []);
  }
  return new Set();
}

export function createStage(root, { store, onFocus, onAside, onDismiss, avatarFor, talk } = {}) {
  root.classList.add('stage');
  const empty = div('stage-empty', icon('group'));
  const grid = div('grid');
  root.append(empty, grid);

  const tiles = new Map(); // participant name -> tile record
  const tracker = createMoodTracker(); // surprise and nod windows; calls back when one opens and when it closes
  let raf = 0;
  let layoutKey = '';
  let lastCount = -1;
  let relayoutTimer = 0;
  let toolsTimer = 0;
  let pointerType = 'mouse';

  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };

  // ---- tile construction ----
  function makeTile(p) {
    const el = div('tile');
    el.dataset.name = p.name;
    el.setAttribute('role', 'group'); // the buttons inside are the keyboard and screen-reader way in; a click anywhere on the tile is the pointer way
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
    const chip = div('aside-chip', icon('aside') + '<span></span>');
    const toolbar = div('toolbar');
    toolbar.setAttribute('role', 'toolbar');
    const btns = {};
    for (const act of ['aside', 'focus', 'dismiss']) { // focus sits in the middle: a second tap on the tile centre still toggles it
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb tb-' + act;
      b.dataset.act = act;
      b.innerHTML = icon(act);
      btns[act] = b;
      toolbar.append(b);
    }
    const clip = div('tile-clip');
    clip.append(bg, avatarHost, div('mark mark-focus', TRIANGLE), div('mark mark-maybe', TRIANGLE), div('voice', '<i></i><i></i><i></i>'), chip, label, toolbar);
    el.append(clip);
    return { name: p.name, el, glow, avatarHost, avatar: null, avatarKey: null, nameEl, chairEl, subEl, chipText: chip.lastChild, btns, view: {} };
  }

  function dropAvatar(rec) {
    if (rec.avatar && typeof rec.avatar.destroy === 'function') rec.avatar.destroy();
    rec.avatar = null;
  }

  // avatarFor is called once per participant and kept; it is called again only when the taste or look changes
  function mountAvatar(rec, p) {
    const key = (p.taste || '') + '|' + JSON.stringify(p.look || {});
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

  function update(rec, p, ctx) {
    const { t, now } = ctx;
    const label = p.label || p.name;
    const sub = p.status === 'busy' || p.status === 'absent' ? t(p.status) : '';
    const focused = ctx.focus.has(p.name);
    const asideNext = ctx.aside.has(p.name);
    mountAvatar(rec, p);
    setText(rec, 'label', rec.nameEl, label);
    setText(rec, 'chair', rec.chairEl, p.chair ? t('chair') : '');
    setText(rec, 'sub', rec.subEl, sub);
    setText(rec, 'chip', rec.chipText, t('asideNext'));
    setAttr(rec, 'aria', rec.el, 'aria-label', sub ? `${label}, ${sub}` : label);
    setAttr(rec, 'taste', rec.el, 'data-taste', p.taste || '');
    setFlag(rec, 'is-focus', focused);
    setFlag(rec, 'is-maybe', ctx.maybe.has(p.name));
    setFlag(rec, 'is-aside', asideNext);
    setFlag(rec, 'is-speaking', ctx.speaking.has(p.name));
    setFlag(rec, 'is-away', p.status === 'absent');
    for (const [act, tip] of [['focus', t('focus')], ['aside', t('aside')], ['dismiss', t('dismiss')]]) {
      setAttr(rec, 'tip-' + act, rec.btns[act], 'aria-label', tip);
      setAttr(rec, 'title-' + act, rec.btns[act], 'title', tip);
    }
    for (const [act, on] of [['focus', focused], ['aside', asideNext]]) {
      if (rec.view['on-' + act] === on) continue;
      rec.view['on-' + act] = on;
      rec.btns[act].classList.toggle('on', on);
      rec.btns[act].setAttribute('aria-pressed', String(on));
    }

    const mood = moodOf({
      status: p.status,
      speaking: ctx.speaking.has(p.name),
      listening: ctx.talking && (focused || asideNext),
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
    const n = tiles.size;
    const W = root.clientWidth;
    const H = root.clientHeight;
    if (n !== lastCount) {
      if (lastCount > 0 && n > 0) {
        root.classList.add('relayout');
        clearTimeout(relayoutTimer);
        relayoutTimer = setTimeout(() => root.classList.remove('relayout'), 320);
      }
      lastCount = n;
    }
    root.dataset.count = String(n);
    if (!n || !W || !H) return;
    const { cols, tw, th } = fit(n, W, H, parseFloat(getComputedStyle(grid).columnGap) || 12);
    const key = `${cols}/${tw}/${th}`;
    if (key === layoutKey) return;
    layoutKey = key;
    root.style.setProperty('--tw', tw + 'px');
    root.style.setProperty('--th', th + 'px');
    root.dataset.cols = String(cols);
  }

  // ---- render ----
  function render() {
    raf = 0;
    const s = store.state || {};
    const uiMap = s.ui || {};
    const hasUi = Object.keys(uiMap).length > 0;
    const t = (k) => (hasUi ? uiMap[k] ?? k : '');
    const list = s.list || [];
    const people = s.participants || [];
    const ctx = {
      t,
      now: Date.now(),
      focus: new Set(s.focus || []),
      aside: new Set([].concat(s.aside || [])),
      maybe: maybeNames(list),
      speaking: speakingNames(s),
      talking: !!talk && !!talk.state && talk.state !== 'idle',
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
    }
    applyLayout();
  }

  store.on('signal', (sig) => tracker.signal(sig));
  const offTracker = tracker.onChange(schedule);

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
  const act = (kind, name) => {
    if (kind === 'focus' && onFocus) onFocus(name);
    else if (kind === 'aside' && onAside) onAside(name);
    else if (kind === 'dismiss' && onDismiss) onDismiss(name);
  };

  const onPointerDown = (e) => {
    pointerType = e.pointerType || 'mouse';
    if (!(e.target instanceof Element) || !e.target.closest('.tile')) hideTools();
  };
  document.addEventListener('pointerdown', onPointerDown, true);

  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const name = tile.dataset.name;
    const btn = e.target.closest('.tb');
    if (btn) {
      if (pointerType !== 'mouse') showTools(tile);
      act(btn.dataset.act, name);
      if (e.detail) btn.blur(); // a focused button would also react to Space, which is the talk key
      return;
    }
    if (pointerType !== 'mouse') showTools(tile); // touch: the first tap also floats the toolbar
    act('focus', name);
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
    destroy() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', applyLayout);
      if (ro) ro.disconnect();
      if (typeof unsubscribe === 'function') unsubscribe();
      offTracker();
      clearTimeout(toolsTimer);
      clearTimeout(relayoutTimer);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
