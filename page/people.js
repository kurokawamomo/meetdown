// people.js: the People panel, like Meet's. "In the meeting" lists the participants (letter circle or image,
// name, chair, speaking bars, talk-to-this-one (lit while it holds the baton), remove); "Not in the meeting" lists live sessions that can be invited.
// It shows while body[data-panel] is 'people'; the bar's people button opens it.

import { initialOf, colorOf, distinctLetters } from './avatar/meet.js';

const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const BARS = '<svg class="pp-bars" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="8" width="3" height="8" rx="1.5"/><rect x="10.5" y="5" width="3" height="14" rx="1.5"/><rect x="16" y="8" width="3" height="8" rx="1.5"/></svg>';
const MIC = '<svg class="pp-baton" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
const REMOVE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 8c0-2.21-1.79-4-4-4S6 5.79 6 8s1.79 4 4 4 4-1.79 4-4zm3 6v-2h6v2h-6zM2 18v2h16v-2c0-2.66-5.33-4-8-4s-8 1.34-8 4z"/></svg>';
const ADD = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const textOr = (t, key, fallback) => { const v = t(key); return v && v !== key ? v : fallback; };

export function createPeople(root, { store, onDismiss, onInvite, onBaton, fetchLive }) {
  root.className = 'panel people';
  const title = el('h2', 'panel-title');
  const closeBtn = el('button', 'x-btn');
  closeBtn.type = 'button';
  closeBtn.innerHTML = CLOSE;
  closeBtn.addEventListener('click', () => { delete document.body.dataset.panel; });
  const head = el('div', 'panel-head');
  head.append(title, closeBtn);
  const list = el('div', 'panel-list');
  root.append(head, list);

  let live = [];
  let liveAt = 0;
  const isOpen = () => document.body.dataset.panel === 'people';
  async function refreshLive() {
    if (!fetchLive || Date.now() - liveAt < 5000) return;
    liveAt = Date.now();
    try { live = await fetchLive(); } catch (_) { live = []; }
    render();
  }

  function badge(name, label, look = {}, letter) {
    const b = el('span', 'pp-badge');
    if (look.imageUrl) {
      const img = el('img');
      img.src = look.imageUrl;
      img.alt = '';
      b.append(img);
    } else {
      b.textContent = look.letter || letter || initialOf(label);
      b.style.background = colorOf(name, look);
    }
    return b;
  }

  function section(name, count) {
    const s = el('div', 'pp-section');
    s.append(el('span', 'pp-section-name', name), el('span', 'pp-count', String(count)));
    return s;
  }

  function render() {
    if (!isOpen()) return;
    const s = store.state;
    const t = (k) => (s.ui && s.ui[k]) ?? k;
    title.textContent = textOr(t, 'people', 'People');
    closeBtn.setAttribute('aria-label', textOr(t, 'close', 'Close'));
    const people = s.participants || [];
    const letters = distinctLetters(people);
    const speaking = new Set(s.speaking || []);
    const baton = new Set((s.baton && s.baton.holders) || s.baton || []);
    const rows = [section(textOr(t, 'inMeeting', 'In the meeting'), people.length + 1)];

    const me = el('div', 'pp-row');
    const owner = (s.me && s.me.owner) || '';
    me.append(badge('human', owner, { color: '#1a73e8' }), el('span', 'pp-name', `${owner} (${textOr(t, 'you', 'you')})`));
    rows.push(me);

    for (const p of people) {
      const row = el('div', 'pp-row');
      const name = el('span', 'pp-name', p.label || p.name);
      if (p.chair) name.append(el('span', 'pp-tag', textOr(t, 'chair', 'chair')));
      const marks = el('span', 'pp-marks');
      if (speaking.has(p.name)) marks.insertAdjacentHTML('beforeend', BARS);
      const talkTo = el('button', 'pp-act' + (baton.has(p.name) ? ' on' : '')); // lit while it holds the baton
      talkTo.type = 'button';
      talkTo.innerHTML = MIC;
      talkTo.title = textOr(t, 'talkTo', 'Talk to this one');
      talkTo.setAttribute('aria-label', talkTo.title);
      talkTo.addEventListener('click', () => onBaton && onBaton(p.name));
      const remove = el('button', 'pp-act');
      remove.type = 'button';
      remove.innerHTML = REMOVE;
      remove.title = textOr(t, 'dismiss', 'Remove');
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => onDismiss && onDismiss(p.name));
      row.append(badge(p.name, p.label || p.name, p.look || {}, letters[p.name]), name, marks, talkTo, remove);
      rows.push(row);
    }

    const out = live.filter((x) => !people.some((p) => p.name === x.name));
    const outLetters = distinctLetters(out);
    if (out.length) {
      rows.push(section(textOr(t, 'notInMeeting', 'Not in the meeting'), out.length));
      for (const x of out) {
        const row = el('div', 'pp-row pp-out');
        const add = el('button', 'pp-act');
        add.type = 'button';
        add.innerHTML = ADD;
        add.title = textOr(t, 'invite', 'Invite');
        add.setAttribute('aria-label', add.title);
        add.addEventListener('click', () => { if (onInvite) onInvite(x.name); liveAt = 0; });
        row.append(badge(x.name, x.label || x.name, {}, outLetters[x.name]), el('span', 'pp-name', x.label || x.name), el('span', 'pp-marks'), add);
        rows.push(row);
      }
    }
    list.replaceChildren(...rows);
  }

  store.subscribe(() => { render(); if (isOpen()) refreshLive(); });
  new MutationObserver(() => { if (isOpen()) { liveAt = 0; refreshLive(); render(); } }).observe(document.body, { attributes: true, attributeFilter: ['data-panel'] });
}
