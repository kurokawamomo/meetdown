// Avatar taste "meet": the default letter avatar of a video call (coloured circle, uppercase first letter of the label)
// with light mood effects: speaking ring pulse, thinking tilt, listening nod, surprised pop, away dim.
//
// create({ seed, look, label }) -> { el, mood, setMood(mood), destroy() }
//   look: optional { color: '#rrggbb', letter: 'X' }

import { MOODS } from './mood.js';

export const id = 'meet';

const COLORS = ['#1a73e8', '#188038', '#8430ce', '#c2185b', '#d93025', '#b06000', '#007b83', '#5b6dc8', '#1e8e3e', '#a52714', '#3949ab', '#00796b'];

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// White letter on every palette colour; a light custom colour (a pastel look from a participant) gets a dark tint of itself.
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const luma = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return luma < 0.3 ? '#fff' : `rgb(${rgb.map((v) => Math.round(v * 0.36)).join(',')})`;
}

export function initialOf(text) {
  const first = Array.from(String(text || '').trim())[0] || '?';
  return first.toLocaleUpperCase();
}

const CSS = `
.mt-root{display:block;width:100%;height:100%;overflow:visible;transition:opacity .35s,filter .35s;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.mt-pose,.mt-ring,.mt-fx-dots circle,.mt-fx-bang,.mt-z{transform-box:fill-box;transform-origin:50% 50%}
.mt-fx-bang{transform-origin:50% 100%}
.mt-letter{fill:var(--mt-ink,#fff);font:500 104px/1 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;text-anchor:middle}
.mt-ring{opacity:0}
.mt-fx>*{display:none}
.mt-m-thinking .mt-fx-dots,.mt-m-surprised .mt-fx-bang,.mt-m-away .mt-fx-zzz{display:inline}

.mt-m-speaking .mt-ring{animation:mt-ring 1.3s ease-out infinite}
.mt-m-speaking .mt-ring-2{animation-delay:.65s}
.mt-m-thinking .mt-pose{animation:mt-tilt 2.8s ease-in-out infinite}
.mt-m-listening .mt-pose{animation:mt-nod 1s ease-in-out infinite}
.mt-m-surprised .mt-pose{animation:mt-pop .5s cubic-bezier(.3,1.5,.5,1) 1 both}
.mt-m-surprised .mt-ring-1{animation:mt-flash .6s ease-out 1 both}
.mt-m-surprised .mt-fx-bang{animation:mt-bang .45s cubic-bezier(.3,1.6,.5,1) 1 both}
.mt-m-away{opacity:.5;filter:saturate(.35)}
.mt-fx-dots circle{animation:mt-dot 1.2s ease-in-out infinite}
.mt-fx-dots circle:nth-of-type(2){animation-delay:.2s}
.mt-fx-dots circle:nth-of-type(3){animation-delay:.4s}
.mt-z{animation:mt-z 3.2s ease-in-out infinite}
.mt-z2{animation-delay:-1.6s}
.mt-z3{animation-delay:-2.7s}

@keyframes mt-ring{0%{opacity:.6;transform:scale(1)}100%{opacity:0;transform:scale(1.32)}}
@keyframes mt-flash{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(1.28)}}
@keyframes mt-tilt{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}
@keyframes mt-nod{0%,62%,100%{transform:translateY(0) scale(1)}30%{transform:translateY(7px) scale(1.02,.98)}}
@keyframes mt-pop{0%{transform:scale(1)}45%{transform:scale(1.18)}100%{transform:scale(1)}}
@keyframes mt-bang{0%{transform:scale(.1);opacity:0}60%{transform:scale(1.25);opacity:1}100%{transform:scale(1);opacity:1}}
@keyframes mt-dot{0%,100%{opacity:.45;transform:scale(1)}35%{opacity:1;transform:scale(1.35)}}
@keyframes mt-z{0%{opacity:0;transform:translate(0,8px) scale(.6)}15%{opacity:1}75%{opacity:1}100%{opacity:0;transform:translate(8px,-12px) scale(1.12)}}
@media (prefers-reduced-motion:reduce){.mt-root,.mt-root *{animation:none!important;transition:none!important}.mt-m-speaking .mt-ring-1{opacity:.55}}
`;

function ensureStyle() {
  if (document.getElementById('mt-style')) return;
  const el = document.createElement('style');
  el.id = 'mt-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

function build({ color, ink, letter, label }) {
  const z = (cls, x, y, k) => `<g transform="translate(${x} ${y}) scale(${k})"><path class="mt-z ${cls}" d="M0 0L14 0L0 16L14 16" fill="none" stroke="#e8eaed" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  return `<svg class="mt-root mt-m-idle" viewBox="0 0 240 240" role="img" aria-label="${label}" style="--mt-ink:${ink}">` +
    `<g class="mt-pose">` +
    `<circle class="mt-ring mt-ring-1" cx="120" cy="124" r="88" fill="none" stroke="${color}" stroke-width="6"/>` +
    `<circle class="mt-ring mt-ring-2" cx="120" cy="124" r="88" fill="none" stroke="${color}" stroke-width="6"/>` +
    `<circle class="mt-disc" cx="120" cy="124" r="88" fill="${color}"/>` +
    `<text class="mt-letter" x="120" y="124" dy=".35em" text-anchor="middle">${esc(letter)}</text>` +
    `</g>` +
    `<g class="mt-fx">` +
    `<g class="mt-fx-dots"><rect x="172" y="4" width="64" height="32" rx="16" fill="#ffffff" fill-opacity=".22"/><path d="M182 34L177 46L192 35Z" fill="#ffffff" fill-opacity=".22"/>` +
    `<circle cx="190" cy="20" r="5.6" fill="#f1f3f4"/><circle cx="204" cy="20" r="5.6" fill="#f1f3f4"/><circle cx="218" cy="20" r="5.6" fill="#f1f3f4"/></g>` +
    `<g class="mt-fx-bang"><rect x="203" y="6" width="12" height="27" rx="6" fill="#ffc933"/><circle cx="209" cy="44" r="6.4" fill="#ffc933"/></g>` +
    `<g class="mt-fx-zzz">${z('mt-z1', 176, 70, 0.7)}${z('mt-z2', 190, 46, 0.9)}${z('mt-z3', 206, 20, 1.15)}</g>` +
    `</g></svg>`;
}

export function create({ seed = '', look = {}, label } = {}) {
  ensureStyle();
  const l = look || {};
  const color = /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : COLORS[hash32('mt|' + String(seed)) % COLORS.length];
  const tpl = document.createElement('template');
  tpl.innerHTML = build({ color, ink: inkFor(color), letter: l.letter || initialOf(label || seed), label: esc(label || seed || 'avatar') });
  const el = tpl.content.firstElementChild;
  let mood = 'idle';
  return {
    el,
    get mood() { return mood; },
    setMood(next) {
      const m = MOODS.includes(next) ? next : 'idle';
      if (m === mood) return;
      el.classList.remove('mt-m-' + mood);
      el.classList.add('mt-m-' + m);
      mood = m;
    },
    destroy() { el.remove(); },
  };
}
