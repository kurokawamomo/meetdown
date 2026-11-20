// panel.js: the minutes. One entry per utterance; an entry is patched in place when the server re-emits it
// (for example its play state turning into cut, dropped or error). The bar toggles body[data-panel].

const ICON_ARROW = '<svg class="m-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

const PLAY_TAGS = ['cut', 'dropped', 'error'];
const SYSTEM_LINE = ['join', 'leave', 'no_reply', 'note'];
const STICK_PX = 48;

const pad2 = (n) => String(n).padStart(2, '0');
const hueOf = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
};
const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

function node(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function createPanel(root, { store } = {}) {
  root.classList.add('panel');
  const title = node('h2', 'panel-title');
  const closeBtn = node('button', 'x-btn');
  closeBtn.type = 'button';
  closeBtn.innerHTML = ICON_CLOSE;
  const head = node('div', 'panel-head');
  head.append(title, closeBtn);
  const listEl = node('div', 'panel-list');
  listEl.setAttribute('role', 'log');
  root.append(head, listEl);

  const entries = new Map(); // utterance id -> { el, sig }
  const labels = new Map(); // participant name -> label; kept after they leave so old lines keep their names
  let meetingId = null;
  let raf = 0;
  let dirty = true;
  let uiRef = null;
  let labelsChanged = false;
  let envVersion = 0;

  const isOpen = () => document.body.dataset.panel === 'open';
  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };

  // ---- what an utterance looks like, as plain data (pure; the DOM is painted from it) ----
  function describe(u, t) {
    const labelOf = (name) => (name === 'human' ? t('you') : name === 'system' ? t('meeting') : labels.get(name) || name);
    const time = timeOf(u.at);
    if (SYSTEM_LINE.includes(u.kind)) {
      const who = u.kind === 'note' ? '' : labelOf(u.from);
      const text = u.kind === 'no_reply' ? `${who}: ${u.text || ''}` : `${who} ${u.text || ''}`.trim();
      return { type: 'sys', text, time };
    }
    const to = (u.to || []).map(labelOf).join(', ');
    const tags = [];
    if (u.aside) tags.push(['aside', t('aside')]);
    if (PLAY_TAGS.includes(u.play)) tags.push([u.play, t(u.play)]);
    const special = u.kind === 'share' || u.kind === 'summary';
    return {
      type: 'msg',
      kind: special ? u.kind : '',
      human: u.from === 'human',
      hue: u.from === 'human' || special ? null : hueOf(u.from),
      from: u.kind === 'share' ? t('share') : u.kind === 'summary' ? t('summary') : labelOf(u.from),
      to,
      tags,
      text: u.text || '',
      time,
    };
  }

  function paint(el, v) {
    el.replaceChildren();
    if (v.type === 'sys') {
      el.className = 'm m-sys';
      el.append(node('span', 'm-sys-text', v.text), node('span', 'm-time', v.time));
      return;
    }
    el.className = 'm' + (v.kind ? ' m-' + v.kind : '') + (v.human ? ' m-human' : '');
    const header = node('div', 'm-head');
    if (v.hue !== null || v.human) {
      const dot = node('span', 'm-dot');
      if (v.hue !== null) dot.style.setProperty('--hue', v.hue);
      header.append(dot);
    }
    header.append(node('span', 'm-from', v.from));
    if (v.to) {
      const arrow = document.createElement('span');
      arrow.innerHTML = ICON_ARROW;
      header.append(arrow.firstChild, node('span', 'm-to', v.to));
    }
    for (const [kind, text] of v.tags) header.append(node('span', 'tag tag-' + kind, text));
    header.append(node('span', 'm-time', v.time));
    el.append(header, node('p', 'm-body', v.text));
  }

  function render() {
    raf = 0;
    if (!isOpen()) { dirty = true; return; } // nothing is visible while the panel is closed
    const s = store.state || {};
    const ui = s.ui || {};
    const hasUi = Object.keys(ui).length > 0;
    const t = (k) => (hasUi ? ui[k] ?? k : '');
    const list = s.list || [];
    for (const p of s.participants || []) {
      const label = p.label || p.name;
      if (labels.get(p.name) === label) continue;
      labels.set(p.name, label);
      labelsChanged = true;
    }
    if (title.textContent !== t('minutes')) title.textContent = t('minutes');
    closeBtn.setAttribute('aria-label', t('back'));
    root.setAttribute('aria-label', t('minutes'));

    const id = s.meeting && s.meeting.id;
    if (id !== meetingId || list.length < entries.size) {
      meetingId = id;
      entries.clear();
      listEl.replaceChildren();
    }
    // an utterance object the store did not replace, drawn under the same ui and labels, is skipped
    const env = ui !== uiRef || labelsChanged ? ++envVersion : envVersion;
    uiRef = ui;
    labelsChanged = false;
    const stick = dirty || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < STICK_PX;
    for (const u of list) {
      let rec = entries.get(u.id);
      if (!rec) {
        rec = { el: document.createElement('article'), src: null, env: -1, sig: null };
        entries.set(u.id, rec);
        listEl.append(rec.el);
      }
      if (rec.src === u && rec.env === env) continue;
      rec.src = u;
      rec.env = env;
      const v = describe(u, t);
      const sig = JSON.stringify(v);
      if (rec.sig !== sig) {
        rec.sig = sig;
        paint(rec.el, v);
      }
    }
    dirty = false;
    if (stick) listEl.scrollTop = listEl.scrollHeight;
  }

  closeBtn.addEventListener('click', () => { delete document.body.dataset.panel; });
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['data-panel'] });
  store.subscribe(schedule);
  schedule();

  return { render: schedule };
}
