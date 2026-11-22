// bar.js: the bottom bar (clock, mic, chat input, invite, more, leave, minutes toggle) and the layers it opens:
// invite dialog, avatar-style menu, leave countdown, toast. All text comes from store.state.ui.

const ICON = {
  mic: '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>',
  micOff: '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>',
  send: '<path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/>',
  personAdd: '<path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  more: '<path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>',
  chat: '<path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>',
  callEnd: '<path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.73-1.68-1.36-2.66-1.85-.33-.16-.56-.51-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>',
  close: '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
  check: '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
};
const icon = (name, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"${cls ? ` class="${cls}"` : ''}>${ICON[name]}</svg>`;

const PANEL_KEY = 'meetdown.panel';
const RING = 339.3; // circumference of the countdown ring (r = 54)
const GRACE_FALLBACK_MS = 10000;
const FALLBACK_TASTES = ['pixel', 'meet'];
// ui keys this module renders; a changed value anywhere in this list re-applies the texts
const UI_KEYS = ['talk', 'placeholder', 'send', 'invite', 'inviteTitle', 'more', 'taste', 'leave', 'back', 'summary', 'minutes', 'holding', 'toggled', 'inviteAsk', 'inviteYes', 'inviteNo'];

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
const button = (cls, html) => {
  const b = el('button', cls, html);
  b.type = 'button';
  return b;
};
const hueOf = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
};
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const pad2 = (n) => String(n).padStart(2, '0');

export function createBar(root, { store, talk, onText, onInvite, onLeave, onBack, onTaste, fetchLive } = {}) {
  root.classList.add('bar');
  const overlays = document.getElementById('overlays') || document.body;
  const canHover = typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
  let uiSig = null;
  let uiRef = null;
  let uiHas = false;
  // text for a ui key; empty until the first snapshot has delivered ui
  const t = (k) => {
    const ui = store.state.ui || {};
    if (ui !== uiRef) { uiRef = ui; uiHas = Object.keys(ui).length > 0; }
    return uiHas ? ui[k] ?? k : '';
  };

  // ---- bar ----
  const clock = el('span', 'bar-clock');
  const sep = el('i', 'bar-sep');
  const mid = el('span', 'bar-mid');
  const left = el('div', 'bar-left');
  left.append(clock, sep, mid);

  // idle shows Meet's muted microphone, recording the plain one, a tap-to-send recording the send arrow
  const micBtn = button('btn mic', icon('micOff', 'ico-off') + icon('mic', 'ico-on') + icon('send', 'ico-send'));
  micBtn.dataset.state = 'idle';
  micBtn.setAttribute('aria-pressed', 'false');
  const micHint = el('div', 'mic-hint');
  micHint.setAttribute('aria-hidden', 'true');
  const micWrap = el('div', 'mic-wrap');
  micWrap.dataset.state = 'idle';
  micWrap.append(micBtn, micHint);

  const input = el('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'send';
  const sendBtn = button('chat-send', icon('send'));
  sendBtn.type = 'submit';
  const form = el('form', 'chat');
  form.append(input, sendBtn);

  const inviteBtn = button('btn btn-invite', icon('personAdd'));
  const moreBtn = button('btn btn-more', icon('more'));
  moreBtn.setAttribute('aria-haspopup', 'menu');
  const leaveBtn = button('leave', icon('callEnd'));
  const center = el('div', 'bar-center');
  center.append(micWrap, form, inviteBtn, moreBtn, leaveBtn);

  const panelBtn = button('btn ghost btn-panel', icon('chat'));
  panelBtn.setAttribute('aria-pressed', 'false');
  const badge = el('span', 'badge');
  badge.hidden = true;
  panelBtn.append(badge);
  const right = el('div', 'bar-right');
  right.append(panelBtn);

  const toast = el('div', 'toast');
  toast.setAttribute('role', 'status');
  // "Invite X?" chip above the bar (a spoken invite asks first)
  const askText = el('span', 'ask-text');
  const askNo = button('ask-btn ask-no');
  const askYes = button('ask-btn ask-yes');
  const ask = el('div', 'invite-ask');
  ask.setAttribute('role', 'group');
  ask.append(askText, askNo, askYes);
  root.append(left, center, right, toast, ask);

  // ---- invite dialog ----
  const dialogTitle = el('h2', 'dialog-title');
  const dialogClose = button('x-btn', icon('close'));
  const dialogList = el('div', 'dialog-list');
  const dialog = el('div', 'dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const dialogHead = el('div', 'dialog-head');
  dialogHead.append(dialogTitle, dialogClose);
  dialog.append(dialogHead, dialogList);
  const scrim = el('div', 'dialog-scrim');
  scrim.append(dialog);

  // ---- avatar-style menu ----
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');

  // ---- leave overlay: countdown while leaving, then ended and the summary ----
  const ring = el('div', 'ring', '<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="54"></circle><circle class="ring-fill" cx="60" cy="60" r="54"></circle></svg>');
  const ringArc = ring.querySelector('.ring-fill');
  const ringNum = el('div', 'ring-num');
  ring.append(ringNum);
  const leaveText = el('p', 'leave-text');
  const wait = el('div', 'wait');
  const backBtn = button('leave-back');
  const sumTitle = el('h3', 'leave-sum-title');
  const sumText = el('p', 'leave-sum');
  const card = el('div', 'leave-card');
  card.append(ring, leaveText, wait, backBtn, sumTitle, sumText);
  const leaveOv = el('div', 'leave-ov');
  leaveOv.setAttribute('role', 'alertdialog');
  leaveOv.append(card);

  overlays.append(scrim, menu, leaveOv);

  // ---- texts ----
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
  const label = (node, text) => { setAttr(node, 'aria-label', text); setAttr(node, 'data-tip', text); };

  function applyUi() {
    const sig = UI_KEYS.map(t).join('\u0001');
    if (sig === uiSig) return;
    uiSig = sig;
    setAttr(input, 'placeholder', t('placeholder'));
    setAttr(input, 'aria-label', t('placeholder'));
    setAttr(sendBtn, 'aria-label', t('send'));
    label(inviteBtn, t('invite'));
    label(moreBtn, t('more'));
    label(leaveBtn, t('leave'));
    label(panelBtn, t('minutes'));
    setText(dialogTitle, t('inviteTitle'));
    setAttr(dialogClose, 'aria-label', t('back'));
    setText(backBtn, t('back'));
    setText(sumTitle, t('summary'));
    paintAsk();
    syncMic(true);
  }

  // ---- mic ----
  function syncMic(force) {
    const st = (talk && talk.state) || 'idle';
    if (!force && micBtn.dataset.state === st) return;
    micBtn.dataset.state = st;
    micWrap.dataset.state = st;
    micBtn.setAttribute('aria-pressed', String(st !== 'idle'));
    const text = st === 'holding' ? t('holding') : st === 'toggled' ? t('toggled') : t('talk');
    setAttr(micBtn, 'aria-label', text);
    setAttr(micBtn, 'data-tip', text);
    setText(micHint, st === 'idle' ? '' : text);
  }
  if (talk && typeof talk.bindButton === 'function') talk.bindButton(micBtn);
  if (talk && typeof talk.onChange === 'function') talk.onChange(() => syncMic(false));
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  micBtn.addEventListener('pointerup', () => micBtn.blur()); // a focused button would also react to Space, the talk key

  // ---- live input level: a ring around the mic button that follows the voice ----
  let levelTimer = 0;
  // level is 0..1 (values above 1 are read as a percentage); the ring falls back to the plain pulse when levels stop coming
  function setLevel(level) {
    let v = Number(level);
    if (!Number.isFinite(v)) v = 0;
    if (v > 1) v /= 100;
    v = Math.min(1, Math.max(0, v));
    micBtn.style.setProperty('--lvl', v.toFixed(3));
    micWrap.dataset.live = '1';
    clearTimeout(levelTimer);
    levelTimer = setTimeout(() => { delete micWrap.dataset.live; micBtn.style.removeProperty('--lvl'); }, 700);
  }

  // ---- invite chip ----
  let askNames = null;
  let askYesFn = null;
  let askNoFn = null;
  function paintAsk() {
    if (!askNames) return;
    setText(askText, fill(t('inviteAsk'), { name: askNames.join(', '), names: askNames.join(', ') }));
    setText(askYes, t('inviteYes'));
    setText(askNo, t('inviteNo'));
  }
  function closeAsk() {
    askNames = null;
    askYesFn = null;
    askNoFn = null;
    ask.classList.remove('show');
    root.classList.remove('has-ask');
  }
  function askInvite(names, onYes, onNo) {
    const list = [].concat(names || []).filter(Boolean);
    if (!list.length) return closeAsk();
    askNames = list;
    askYesFn = onYes;
    askNoFn = onNo;
    paintAsk();
    ask.classList.add('show');
    root.classList.add('has-ask');
  }
  askYes.addEventListener('click', () => { const fn = askYesFn; closeAsk(); if (fn) fn(); });
  askNo.addEventListener('click', () => { const fn = askNoFn; closeAsk(); if (fn) fn(); });

  // ---- chat input ----
  input.addEventListener('input', () => form.classList.toggle('has-text', input.value.trim() !== ''));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') input.blur(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    form.classList.remove('has-text');
    if (onText) onText(text);
    if (canHover) input.blur(); // on a desktop, Space goes back to push-to-talk
  });

  // ---- toast: timed notes; while the event stream is down, "reconnecting" stays up ----
  let toastTimer = 0;
  let timed = false;
  let offlineText = '';
  const showToast = (text) => {
    setText(toast, text);
    toast.classList.add('show');
  };
  function settleToast() {
    timed = false;
    if (offlineText) showToast(offlineText);
    else toast.classList.remove('show');
  }
  function note(text, ms = 4200) {
    clearTimeout(toastTimer);
    if (!text) return settleToast();
    timed = true;
    showToast(String(text));
    toastTimer = setTimeout(settleToast, ms);
  }
  function syncConnection() {
    const want = store.state.connected === false ? t('reconnecting') : '';
    if (want === offlineText) return;
    offlineText = want;
    if (!timed) settleToast();
  }
  store.on('note', (m) => note(m && m.text));

  // ---- invite dialog ----
  let inviteToken = 0;
  const inviteOpen = () => scrim.classList.contains('show');
  function closeInvite() {
    inviteToken++;
    scrim.classList.remove('show');
  }
  function inviteRow(s) {
    const text = s.label || s.title || s.name;
    const a = s.address;
    const where = a ? `${a.session}:${a.window}.${a.pane}` : s.pane || '';
    const row = button('row');
    const avatar = el('span', 'row-avatar');
    avatar.style.setProperty('--hue', hueOf(s.name));
    avatar.textContent = Array.from(text)[0] || '';
    const body = el('span', 'row-body');
    const title = el('span', 'row-title');
    title.textContent = text;
    const sub = el('span', 'row-sub');
    sub.textContent = s.name !== text ? `${where}  ${s.name}` : where;
    body.append(title, sub);
    const status = el('span', 'row-status');
    const dot = el('i', 'dot');
    dot.dataset.status = s.status || '';
    const statusText = el('span');
    const ui = store.state.ui || {};
    statusText.textContent = ui[s.status] ?? s.status ?? '';
    status.append(dot, statusText);
    row.append(avatar, body, status);
    row.addEventListener('click', () => {
      closeInvite();
      if (onInvite) onInvite(s.name);
    });
    return row;
  }
  function fillInvite(rows) {
    const list = (rows || []).filter(Boolean);
    if (!list.length) {
      const e = el('div', 'dialog-empty');
      e.textContent = t('noOneToInvite');
      dialogList.replaceChildren(e);
      return;
    }
    dialogList.replaceChildren(...list.map(inviteRow));
  }
  function openInvite() {
    closeMenu();
    scrim.classList.add('show');
    dialogList.replaceChildren(el('div', 'spinner'));
    const token = ++inviteToken;
    Promise.resolve()
      .then(() => (fetchLive ? fetchLive() : []))
      .then((rows) => { if (token === inviteToken) fillInvite(rows); })
      .catch((e) => { console.warn('fetchLive failed', e); if (token === inviteToken) fillInvite([]); });
  }
  inviteBtn.addEventListener('click', () => (inviteOpen() ? closeInvite() : openInvite()));
  dialogClose.addEventListener('click', closeInvite);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) closeInvite(); });

  // ---- avatar-style menu ----
  const menuOpen = () => menu.classList.contains('show');
  const tasteIds = () => {
    const tastes = store.state.tastes;
    if (Array.isArray(tastes)) return tastes.map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
    if (tastes && typeof tastes === 'object') return Object.keys(tastes);
    return FALLBACK_TASTES;
  };
  const tasteLabel = (id) => {
    const ui = store.state.ui || {};
    return ui['taste' + id.charAt(0).toUpperCase() + id.slice(1)] ?? id;
  };
  function buildMenu() {
    const ids = tasteIds();
    const people = store.state.participants || [];
    const items = [];
    const head = el('div', 'menu-head');
    head.textContent = t('taste');
    items.push(head);
    for (const id of ids) {
      const item = button('menu-item', icon('check') + '<span></span>');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(people.length > 0 && people.every((p) => p.taste === id)));
      item.lastChild.textContent = tasteLabel(id);
      item.addEventListener('click', () => { closeMenu(); if (onTaste) onTaste(id, '*'); });
      items.push(item);
    }
    if (people.length) {
      items.push(el('div', 'menu-sep'));
      for (const p of people) {
        const row = el('div', 'menu-person');
        const name = el('span', 'menu-person-name');
        name.textContent = p.label || p.name;
        const chips = el('span', 'menu-chips');
        for (const id of ids) {
          const chip = button('chip');
          chip.setAttribute('role', 'menuitemradio');
          chip.setAttribute('aria-checked', String(p.taste === id));
          chip.textContent = tasteLabel(id);
          chip.addEventListener('click', () => { closeMenu(); if (onTaste) onTaste(id, p.name); });
          chips.append(chip);
        }
        row.append(name, chips);
        items.push(row);
      }
    }
    menu.replaceChildren(...items);
  }
  function placeMenu() {
    const r = moreBtn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8) + 'px';
    menu.style.bottom = window.innerHeight - r.top + 12 + 'px';
  }
  function openMenu() {
    closeInvite();
    buildMenu();
    menu.classList.add('show');
    placeMenu();
    moreBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.classList.remove('show');
    moreBtn.setAttribute('aria-expanded', 'false');
  }
  moreBtn.addEventListener('click', () => (menuOpen() ? closeMenu() : openMenu()));
  document.addEventListener('pointerdown', (e) => {
    if (menuOpen() && !menu.contains(e.target) && !moreBtn.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    closeInvite();
  });
  window.addEventListener('resize', () => { if (menuOpen()) placeMenu(); });

  // ---- leave, back, countdown ----
  leaveBtn.addEventListener('click', () => { if (onLeave) onLeave(); });
  backBtn.addEventListener('click', () => { if (onBack) onBack(); });
  let phase = null;
  let leaveEnd = 0;
  let leaveTotal = GRACE_FALLBACK_MS;
  let leaveTimer = 0;

  function tick() {
    const ms = Math.max(0, leaveEnd - Date.now());
    const seconds = Math.ceil(ms / 1000);
    setText(ringNum, String(seconds));
    setText(leaveText, fill(t('leaving'), { seconds }));
    ringArc.style.strokeDashoffset = String(RING * (1 - Math.min(1, ms / leaveTotal)));
  }
  function summaryText() {
    const s = store.state;
    if (s.summary) return typeof s.summary === 'string' ? s.summary : s.summary.text || '';
    const found = (s.list || []).filter((u) => u.kind === 'summary').pop();
    return found ? found.text : '';
  }
  function syncPhase() {
    const m = store.state.meeting || {};
    const next = m.state === 'leaving' || m.state === 'closing' || m.state === 'closed' ? m.state : null;
    if (next === 'leaving' && phase !== 'leaving') {
      // the server clock may differ from this device's clock: trust the deadline only when it is plausible
      const remaining = m.deadline ? Date.parse(m.deadline) - Date.now() : NaN;
      leaveTotal = remaining > 0 && remaining <= 3 * GRACE_FALLBACK_MS ? remaining : GRACE_FALLBACK_MS;
      leaveEnd = Date.now() + leaveTotal;
      clearInterval(leaveTimer);
      leaveTimer = setInterval(tick, 200);
      tick();
    }
    if (next !== 'leaving') clearInterval(leaveTimer);
    if (next !== phase) {
      phase = next;
      leaveOv.classList.toggle('show', !!next);
      if (next) leaveOv.dataset.phase = next;
      else delete leaveOv.dataset.phase;
    }
    if (next === 'closing' || next === 'closed') setText(leaveText, t('ended'));
    const sum = next === 'closed' ? summaryText() : '';
    setText(sumText, sum);
    sumText.classList.toggle('has-text', !!sum);
    sumTitle.classList.toggle('has-text', !!sum);
  }

  // ---- minutes panel toggle (the panel itself listens to body[data-panel]) ----
  const body = document.body;
  const wide = () => matchMedia('(min-width: 700px)').matches;
  const panelOpen = () => body.dataset.panel === 'open';
  const setPanel = (open) => {
    if (open) body.dataset.panel = 'open';
    else delete body.dataset.panel;
  };

  // unread: utterances from others that arrived while the panel was closed
  let seenCount = null;
  let seenMeeting = null;
  function syncUnread() {
    const s = store.state;
    const list = s.list || [];
    const id = s.meeting && s.meeting.id;
    if (id !== seenMeeting) { seenMeeting = id; seenCount = id ? list.length : null; }
    let n = 0;
    if (seenCount !== null) {
      if (panelOpen() || list.length < seenCount) seenCount = list.length;
      else for (let i = seenCount; i < list.length; i++) if (list[i].from !== 'human') n++;
    }
    badge.hidden = n === 0;
    setText(badge, n > 9 ? '9+' : n ? String(n) : '');
  }

  // open or closed by anyone (this button, the panel's close button): remember it on wide screens
  function syncPanelButton() {
    panelBtn.setAttribute('aria-pressed', String(panelOpen()));
    try { if (wide()) localStorage.setItem(PANEL_KEY, panelOpen() ? '1' : '0'); } catch (_) { /* storage may be blocked */ }
    syncUnread();
  }
  try {
    if (wide() && localStorage.getItem(PANEL_KEY) === '1') setPanel(true);
  } catch (_) { /* storage may be blocked */ }
  panelBtn.addEventListener('click', () => setPanel(!panelOpen()));
  new MutationObserver(syncPanelButton).observe(body, { attributes: true, attributeFilter: ['data-panel'] });
  panelBtn.setAttribute('aria-pressed', String(panelOpen()));

  // ---- clock, document title, language ----
  function syncClock() {
    const d = new Date();
    setText(clock, `${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
  }
  syncClock();
  setInterval(syncClock, 5000);

  function sync() {
    const s = store.state || {};
    applyUi();
    syncConnection();
    const id = (s.meeting && s.meeting.id) || '';
    setText(mid, id);
    const title = id ? 'meetdown ' + id : 'meetdown';
    if (document.title !== title) document.title = title;
    if (s.lang && document.documentElement.lang !== s.lang) document.documentElement.lang = s.lang;
    syncPhase();
    syncUnread();
    if (menuOpen()) buildMenu();
  }

  // The bar's own click handlers drop focus after a mouse click (Space is the talk key)
  const dropFocus = (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b && e.detail) b.blur();
  };
  root.addEventListener('click', dropFocus);
  overlays.addEventListener('click', dropFocus);

  store.subscribe(sync);
  sync();

  return {
    note,
    setLevel,
    askInvite,
    closeInviteAsk: closeAsk,
    openInvite,
    closeInvite,
    openMenu,
    closeMenu,
    togglePanel: () => setPanel(!panelOpen()),
  };
}
