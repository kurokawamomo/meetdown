// Avatar taste "geo": geometric, design-system style characters.
//
// Every character is built from a few primitives (circles, a dome, capsules, rounded triangles) on one grid:
// head circle at (120,108) r56, eyes at +-24 from the centre line, body dome on the bottom edge.
// Three tones per character (main, dark, light) plus one ink colour. No outlines, no texture.
//
// create({ seed, look, label }) -> { el, mood, setMood(mood), destroy() }
//   el        an <svg> (viewBox 0 0 240 240) that fills the square box its parent gives it
//   setMood   swaps one class on the root (ge-m-<mood>); CSS (prefix ge-) does all the motion
//   look      optional overrides: { species, color, accessory, accessoryColor }
// traitsOf({ seed, look }) returns the chosen traits without touching the DOM.

import { MOODS } from './mood.js';

export const id = 'geo';
export const SPECIES = ['fox', 'cat', 'bear', 'rabbit', 'owl'];
export const ACCESSORIES = ['bowtie', 'ribbon', 'glasses', 'scarf', 'hat', 'none'];

const COLORS = ['#f2a7a3', '#f4a259', '#8fb8de', '#9bc5a1', '#c3a6e0', '#f2cb61', '#7fc8c0', '#e8927c', '#a9b4c8', '#d4aa86'];
const ACCENTS = ['#ef5350', '#ffc83d', '#4aa3f0', '#7c5cc4', '#22a99a', '#ff7a45'];
const INK = '#221f2b';

let serial = 0;

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 4, 97))}%)`;

function toHsl(color) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return null;
  let x = m[1];
  if (x.length === 3) x = x.split('').map((ch) => ch + ch).join('');
  const r = parseInt(x.slice(0, 2), 16) / 255;
  const g = parseInt(x.slice(2, 4), 16) / 255;
  const b = parseInt(x.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: s * 100, l: l * 100, hex: '#' + x.toLowerCase() };
}

export function traitsOf({ seed = '', look = {} } = {}) {
  const rnd = mulberry32(hash32('ge|' + String(seed)));
  const r = Array.from({ length: 12 }, rnd); // fixed draw order: overriding one trait never shifts the others
  const l = look || {};
  const species = SPECIES.includes(l.species) ? l.species : SPECIES[Math.floor(r[0] * SPECIES.length)];
  const accessory = ACCESSORIES.includes(l.accessory) ? l.accessory : ACCESSORIES[Math.floor(r[1] * ACCESSORIES.length)];
  const color = toHsl(l.color) || toHsl(COLORS[Math.floor(r[2] * COLORS.length)]);
  let accent = ACCENTS[Math.floor(r[3] * ACCENTS.length)];
  if (Math.abs(((toHsl(accent).h - color.h + 540) % 360) - 180) < 30) accent = ACCENTS[(ACCENTS.indexOf(accent) + 3) % ACCENTS.length];
  const custom = toHsl(l.accessoryColor);
  const accessoryColor = custom ? custom.hex : accessory === 'bowtie' ? INK : accent;
  return { key: String(seed), species, accessory, color, accessoryColor, r };
}

function paletteOf(c) {
  const lMain = clamp(c.l, 60, 84);
  const sMain = clamp(c.s, 28, 90);
  return {
    main: hsl(c.h, sMain, lMain),
    dark: hsl(c.h + 2, clamp(sMain * 0.9, 0, 85), lMain - 15),
    light: hsl(c.h - 2, clamp(sMain * 0.55, 0, 70), 94),
    ink: INK,
  };
}

const f = (n) => Math.round(n * 10) / 10;

// A rounded triangle: a polygon stroked with its own fill colour and a round join.
const tri = (pts, fill, w = 10) =>
  `<polygon points="${pts}" fill="${fill}" stroke="${fill}" stroke-width="${w}" stroke-linejoin="round"/>`;

const EYE_X = [96, 144];
const EYE_Y = 104;

function ears(sp, p) {
  switch (sp) {
    case 'fox':
      return `<g class="ge-ears">${tri('72,92 60,30 112,64', p.main, 12)}${tri('168,92 180,30 128,64', p.main, 12)}`
        + `${tri('74,80 68,44 98,64', p.dark, 8)}${tri('166,80 172,44 142,64', p.dark, 8)}</g>`;
    case 'cat':
      return `<g class="ge-ears">${tri('70,90 70,34 114,62', p.main, 14)}${tri('170,90 170,34 126,62', p.main, 14)}`
        + `${tri('76,78 76,48 100,62', p.light, 8)}${tri('164,78 164,48 140,62', p.light, 8)}</g>`;
    case 'bear':
      return `<g class="ge-ears"><circle cx="76" cy="66" r="18" fill="${p.main}"/><circle cx="164" cy="66" r="18" fill="${p.main}"/>`
        + `<circle cx="76" cy="66" r="9" fill="${p.dark}"/><circle cx="164" cy="66" r="9" fill="${p.dark}"/></g>`;
    case 'rabbit':
      return `<g class="ge-ears"><g transform="rotate(-9 92 90)"><rect x="80" y="6" width="26" height="86" rx="13" fill="${p.main}"/>`
        + `<rect x="86" y="18" width="14" height="58" rx="7" fill="${p.light}"/></g>`
        + `<g transform="rotate(9 148 90)"><rect x="134" y="6" width="26" height="86" rx="13" fill="${p.main}"/>`
        + `<rect x="140" y="18" width="14" height="58" rx="7" fill="${p.light}"/></g></g>`;
    default: // owl tufts
      return `<g class="ge-ears">${tri('76,80 70,40 108,60', p.main, 12)}${tri('164,80 170,40 132,60', p.main, 12)}</g>`;
  }
}

function tail(sp, p) {
  switch (sp) {
    case 'fox':
      return `<g class="ge-tail"><clipPath id="CLIPT"><circle cx="190" cy="168" r="42"/></clipPath>`
        + `<circle cx="190" cy="168" r="42" fill="${p.main}"/><circle cx="214" cy="146" r="30" fill="${p.light}" clip-path="url(#CLIPT)"/></g>`;
    case 'cat':
      return `<g class="ge-tail"><path d="M168 226 C214 226 222 176 206 146" fill="none" stroke="${p.main}" stroke-width="24" stroke-linecap="round"/></g>`;
    case 'rabbit':
      return `<g class="ge-tail"><circle cx="190" cy="206" r="20" fill="${p.light}"/></g>`;
    default:
      return '';
  }
}

function body(sp, p) {
  let s = `<path d="M44 240 A76 76 0 0 1 196 240 Z" fill="${p.dark}"/>`;
  if (sp === 'fox' || sp === 'rabbit') s += `<path d="M90 240 A30 30 0 0 1 150 240 Z" fill="${p.light}"/>`;
  if (sp === 'owl') s += `<path d="M82 240 A38 38 0 0 1 158 240 Z" fill="${p.light}"/>`;
  return s;
}

function muzzle(sp, p, clipId) {
  switch (sp) {
    case 'fox':
      return `<g clip-path="url(#${clipId})"><circle cx="94" cy="146" r="30" fill="${p.light}"/><circle cx="146" cy="146" r="30" fill="${p.light}"/></g>`;
    case 'cat':
      return `<g clip-path="url(#${clipId})"><circle cx="120" cy="136" r="22" fill="${p.light}"/></g>`;
    case 'bear':
      return `<circle cx="120" cy="138" r="24" fill="${p.light}"/>`;
    case 'rabbit':
      return `<circle cx="108" cy="140" r="15" fill="${p.light}"/><circle cx="132" cy="140" r="15" fill="${p.light}"/>`;
    default:
      return `<circle cx="96" cy="106" r="26" fill="${p.light}"/><circle cx="144" cy="106" r="26" fill="${p.light}"/>`;
  }
}

function nose(sp, p) {
  if (sp === 'owl') return tri('114,124 126,124 120,138', p.accent, 5);
  if (sp === 'bear') return `<ellipse cx="120" cy="127" rx="9" ry="6.5" fill="${p.ink}"/>`;
  return `<path d="M112 118 H128 Q128 125 120 129 Q112 125 112 118 Z" fill="${p.ink}" stroke="${p.ink}" stroke-width="3" stroke-linejoin="round"/>`;
}

function eye(cx, lid) {
  return `<g class="ge-eye"><g class="ge-pupil"><circle cx="${cx}" cy="${EYE_Y}" r="7.5" fill="${INK}"/>`
    + `<circle cx="${f(cx + 2.6)}" cy="${EYE_Y - 3}" r="2.2" fill="#fff"/></g>`
    + `<rect class="ge-lid" x="${cx - 14}" y="${EYE_Y - 14}" width="28" height="24" fill="${lid}"/>`
    + `<path class="ge-closed" d="M${cx - 8} ${EYE_Y + 2} Q${cx} ${EYE_Y + 10} ${cx + 8} ${EYE_Y + 2}" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round"/></g>`;
}

function brow(cx, owl, side) {
  const y = EYE_Y - (owl ? 36 : 21);
  return `<g class="ge-brow ge-b${side}"><rect x="${cx - 9}" y="${y}" width="18" height="4.6" rx="2.3" fill="${INK}"/></g>`;
}

function accessory(kind, color, sp, p) {
  const c = color;
  switch (kind) {
    case 'bowtie':
      return { neck: `<g class="ge-acc">${tri('114,181 92,170 92,192', c, 6)}${tri('126,181 148,170 148,192', c, 6)}<ellipse cx="120" cy="181" rx="7.5" ry="9" fill="${c}"/></g>`, head: '' };
    case 'scarf':
      return { neckBack: `<g class="ge-acc"><rect x="64" y="160" width="112" height="24" rx="12" fill="${c}"/><rect x="138" y="172" width="24" height="46" rx="12" fill="${c}"/></g>`, head: '' };
    case 'ribbon':
      return { neck: '', head: `<g class="ge-acc">${tri('118,54 98,42 98,66', c, 6)}${tri('122,54 142,42 142,66', c, 6)}<circle cx="120" cy="54" r="7.5" fill="${c}"/></g>` };
    case 'glasses': {
      const r = sp === 'owl' ? 29 : 19;
      return { neck: '', head: `<g class="ge-acc" fill="none" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"><circle cx="96" cy="${EYE_Y}" r="${r}"/><circle cx="144" cy="${EYE_Y}" r="${r}"/><path d="M${96 + r} ${EYE_Y - 2} Q120 ${EYE_Y - 8} ${144 - r} ${EYE_Y - 2}"/></g>` };
    }
    case 'hat':
      return { neck: '', head: `<g class="ge-acc" transform="rotate(8 120 50)"><rect x="100" y="12" width="40" height="38" rx="7" fill="${c}"/><rect x="100" y="34" width="40" height="9" fill="${INK}"/><rect x="88" y="44" width="64" height="11" rx="5.5" fill="${c}"/></g>` };
    default:
      return { neck: '', head: '' };
  }
}

function buildSvg(t, label) {
  const p = paletteOf(t.color);
  p.accent = t.accessoryColor === INK ? hsl(t.color.h, 70, 55) : t.accessoryColor;
  const sp = t.species;
  const owl = sp === 'owl';
  const n = ++serial;
  const clipHead = `ge-ch${n}`;
  const clipMouth = `ge-cm${n}`;
  const clipArm = `ge-ca${n}`;
  const lid = owl ? p.light : p.main;
  const acc = accessory(t.accessory, t.accessoryColor, sp, p);
  const blink = (4.6 + t.r[4] * 2.8).toFixed(2);
  const delay = (-t.r[5] * 6).toFixed(2);
  const glance = (9 + t.r[6] * 5).toFixed(2);
  const tailSvg = tail(sp, p).replace(/CLIPT/g, `ge-ct${n}`);
  const mouthOpen = owl ? `<path d="M113 138 H127 L120 152 Z" fill="${p.accent}" stroke="${p.accent}" stroke-width="5" stroke-linejoin="round"/>`
    : `<g clip-path="url(#${clipMouth})"><path d="M106 133 H134 A14 16 0 0 1 106 133 Z" fill="${INK}"/><ellipse cx="120" cy="150" rx="8" ry="6" fill="#ff8a8a"/></g>`;
  const blush = owl ? '' : `<circle class="ge-blush" cx="78" cy="128" r="9" fill="#ff7b8c"/><circle class="ge-blush" cx="162" cy="128" r="9" fill="#ff7b8c"/>`;
  const smile = owl ? '' : `<path class="ge-smile" d="M109 135 Q120 143 131 135" fill="none" stroke="${INK}" stroke-width="4.4" stroke-linecap="round"/>`;
  const oMouth = owl ? '' : `<circle class="ge-o" cx="120" cy="140" r="6.5" fill="${INK}"/>`;
  const z = (x, y, s, i) => `<path class="ge-z ge-z${i}" d="M0 0 H12 L0 14 H12" transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg class="ge-root ge-sp-${sp} ge-m-idle" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${String(label || t.species).replace(/[<>&"]/g, '')}" `
    + `style="--ge-blink:${blink}s;--ge-bd:${delay}s;--ge-glance:${glance}s">`
    + `<defs><clipPath id="${clipHead}"><circle cx="120" cy="108" r="56"/></clipPath>`
    + `<clipPath id="${clipArm}"><rect width="240" height="240"/></clipPath><clipPath id="${clipMouth}"><path d="M106 133 H134 A14 16 0 0 1 106 133 Z"/></clipPath></defs>`
    + `<g class="ge-fig">`
    + tailSvg
    + `<g class="ge-bodyg">${body(sp, p)}</g>`
    + (acc.neckBack || '')
    + `<g class="ge-head">`
    + ears(sp, p)
    + `<circle cx="120" cy="108" r="56" fill="${p.main}"/>`
    + muzzle(sp, p, clipHead)
    + `<g class="ge-blushes">${blush}</g>`
    + eye(EYE_X[0], lid) + eye(EYE_X[1], lid)
    + brow(EYE_X[0], owl, 'l') + brow(EYE_X[1], owl, 'r')
    + nose(sp, p)
    + smile
    + `<g class="ge-talk">${mouthOpen}</g>`
    + oMouth
    + (acc.head || '')
    + `</g>`
    + (acc.neck || '')
    + `<g class="ge-paw"><path d="M172 252 L142 178" stroke="${p.main}" stroke-width="26" stroke-linecap="round" fill="none" clip-path="url(#${clipArm})"/><circle cx="130" cy="164" r="18" fill="${p.main}"/></g>`
    + `</g>`
    + `<g class="ge-dots"><circle cx="192" cy="62" r="3.5"/><circle cx="204" cy="46" r="5"/><circle cx="220" cy="26" r="7"/></g>`
    + `<g class="ge-zs">${z(168, 44, 0.7, 1)}${z(186, 28, 0.9, 2)}${z(206, 10, 1.1, 3)}</g>`
    + `</svg>`;
}

const CSS = `
.ge-root{display:block;width:100%;height:100%;overflow:visible}
.ge-root *{transform-box:fill-box;transform-origin:50% 50%}
.ge-fig,.ge-head,.ge-bodyg,.ge-tail{transform-box:view-box}
.ge-fig{transform-origin:120px 240px}
.ge-head{transform-origin:120px 168px;transition:transform .4s ease}
.ge-bodyg{transform-origin:120px 240px}
.ge-tail{transform-origin:176px 214px}
.ge-lid{transform-box:fill-box;transform-origin:50% 0;transform:scaleY(var(--lr,0))}
.ge-pupil{transition:transform .35s ease}
.ge-closed{opacity:0;transition:opacity .25s}
.ge-brow{opacity:0;transition:transform .3s ease,opacity .3s}
.ge-m-speaking .ge-brow,.ge-m-thinking .ge-brow,.ge-m-listening .ge-brow,.ge-m-surprised .ge-brow{opacity:1}
.ge-talk{transform-origin:50% 0}
.ge-smile{transform-origin:50% 50%;transition:transform .3s ease,opacity .1s}
.ge-talk{opacity:0;transform:scaleY(.1);transition:opacity .1s}
.ge-o{opacity:0;transform:scale(.4);transition:opacity .1s,transform .2s;transform-origin:50% 50%}
.ge-blush{opacity:0;transition:opacity .4s}
.ge-paw{opacity:0;transform:translate(26px,50px);transition:transform .45s cubic-bezier(.3,1.3,.5,1),opacity .25s}
.ge-dots{fill:#fff;opacity:0}
.ge-dots circle{opacity:0}
.ge-zs{opacity:0}
.ge-z{opacity:0}
.ge-fig{transition:filter .6s ease}

/* blink: lid closes from the top, then lifts */
.ge-m-idle .ge-lid,.ge-m-speaking .ge-lid,.ge-m-thinking .ge-lid,.ge-m-listening .ge-lid{animation:ge-blink var(--ge-blink,5.5s) var(--ge-bd,0s) infinite}
.ge-m-listening{--lr:.2}
@keyframes ge-blink{0%,93%,100%{transform:scaleY(var(--lr,0))}95.5%{transform:scaleY(1)}97.5%{transform:scaleY(var(--lr,0))}}

/* idle: breathing, slow glance, tail sway */
.ge-m-idle .ge-bodyg{animation:ge-breath 5s ease-in-out infinite}
.ge-m-idle .ge-head{animation:ge-headfloat 5s ease-in-out infinite}
.ge-m-idle .ge-pupil{animation:ge-glance var(--ge-glance,11s) ease-in-out infinite}
.ge-m-idle .ge-tail,.ge-m-listening .ge-tail,.ge-m-speaking .ge-tail{animation:ge-sway 6s ease-in-out infinite}
.ge-m-idle .ge-smile{transform:scale(.92,.85)}
@keyframes ge-breath{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.018)}}
@keyframes ge-headfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.6px)}}
@keyframes ge-glance{0%,38%,100%{transform:translate(0,0)}46%,70%{transform:translate(3.4px,1px)}78%{transform:translate(0,0)}}
@keyframes ge-sway{0%,100%{transform:rotate(-2.5deg)}50%{transform:rotate(3deg)}}

/* speaking: mouth at about 6 Hz, small bob */
.ge-m-speaking .ge-smile{opacity:0}
.ge-m-speaking .ge-talk{opacity:1;animation:ge-talk .166s ease-in-out infinite alternate}
.ge-m-speaking .ge-head{animation:ge-bob .9s ease-in-out infinite}
.ge-m-speaking .ge-brow{transform:translateY(-1px)}
@keyframes ge-talk{from{transform:scaleY(.18)}to{transform:scaleY(1)}}
@keyframes ge-bob{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(-2.4px) rotate(-1.2deg)}70%{transform:translateY(1px) rotate(1.2deg)}}

/* thinking: tilt, eyes up, small dots, paw at chin */
.ge-m-thinking .ge-head{transform:rotate(-6deg) translate(-3px,1px)}
.ge-m-thinking .ge-pupil{transform:translate(5px,-7px) scale(.74)}
.ge-m-thinking .ge-brow.ge-bl{transform:translateY(-6px) rotate(-6deg)}
.ge-m-thinking .ge-brow.ge-br{transform:translateY(0) rotate(4deg)}
.ge-m-thinking .ge-smile{transform:translateX(7px) scale(.55,.35)}
.ge-m-thinking .ge-paw{opacity:1;transform:translate(0,0)}
.ge-m-thinking .ge-dots{opacity:1}
.ge-m-thinking .ge-dots circle{animation:ge-dot 1.8s ease-in-out infinite}
.ge-m-thinking .ge-dots circle:nth-child(2){animation-delay:.25s}
.ge-m-thinking .ge-dots circle:nth-child(3){animation-delay:.5s}
.ge-m-thinking .ge-pupil{animation:ge-ponder 3.6s ease-in-out infinite}
@keyframes ge-dot{0%,15%{opacity:.15}40%,80%{opacity:1}100%{opacity:.15}}
@keyframes ge-ponder{0%,100%{transform:translate(5px,-7px) scale(.74)}50%{transform:translate(-1px,-7px) scale(.74)}}

/* listening: gentle nods, soft eyes, blush */
.ge-m-listening .ge-head{animation:ge-nod 2.6s ease-in-out infinite}
.ge-m-listening .ge-blush{opacity:.5}
.ge-m-listening .ge-brow{transform:translateY(-3px)}
.ge-m-listening .ge-smile{transform:scale(1.12,1.05)}
@keyframes ge-nod{0%,52%,100%{transform:translateY(0) rotate(0)}12%{transform:translateY(5px) rotate(1.6deg)}24%{transform:translateY(0) rotate(0)}36%{transform:translateY(4px) rotate(1.2deg)}46%{transform:translateY(0) rotate(0)}}

/* surprised: wide eyes, brows up, o mouth, one hop */
.ge-m-surprised .ge-pupil{transform:scale(1.4)}
.ge-m-surprised .ge-lid{transform:scaleY(0)}
.ge-m-surprised .ge-brow{transform:translateY(-12px)}
.ge-m-surprised .ge-smile{opacity:0}
.ge-m-surprised .ge-o{opacity:1;transform:scale(1)}
.ge-m-surprised .ge-talk{opacity:0}
.ge-sp-owl.ge-m-surprised .ge-talk{opacity:1;transform:scaleY(.8)}
.ge-m-surprised .ge-head{transform:translateY(-3px)}
.ge-m-surprised .ge-fig{animation:ge-hop 1.2s ease-out 1}
.ge-m-surprised .ge-tail{animation:ge-sway 1s ease-in-out infinite}
@keyframes ge-hop{0%{transform:translateY(0) scale(1,1)}12%{transform:translateY(0) scale(1.05,.93)}32%{transform:translateY(-20px) scale(.97,1.04)}52%{transform:translateY(0) scale(1.04,.95)}64%{transform:translateY(-6px) scale(1,1)}78%{transform:translateY(0) scale(1.01,.99)}100%{transform:translateY(0) scale(1,1)}}

/* away: eyes closed, dimmed, z */
.ge-m-away .ge-fig{filter:brightness(.62) saturate(.7)}
.ge-m-away .ge-lid{transform:scaleY(1);transition:transform .5s ease}
.ge-m-away .ge-closed{opacity:1}
.ge-m-away .ge-pupil{opacity:0}
.ge-m-away .ge-head{transform:translateY(8px) rotate(4deg)}
.ge-m-away .ge-smile{transform:scale(.8,.7)}
.ge-m-away .ge-bodyg{animation:ge-breath 6.5s ease-in-out infinite}
.ge-m-away .ge-zs{opacity:1}
.ge-m-away .ge-z{animation:ge-z 3.6s ease-in-out infinite}
.ge-m-away .ge-z2{animation-delay:1.2s}
.ge-m-away .ge-z3{animation-delay:2.4s}
@keyframes ge-z{0%{opacity:0}20%{opacity:.9}70%{opacity:.9}100%{opacity:0}}

@media (prefers-reduced-motion:reduce){.ge-root *{animation-duration:0s!important;animation-iteration-count:1!important}}
`;

function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('ge-style')) return;
  const s = document.createElement('style');
  s.id = 'ge-style';
  s.textContent = CSS;
  (document.head || document.documentElement).appendChild(s);
}

export function create({ seed = '', look = {}, label = '' } = {}) {
  injectStyle();
  const t = traitsOf({ seed, look });
  const host = document.createElement('div');
  host.innerHTML = buildSvg(t, label);
  const el = host.firstElementChild;
  const api = {
    el,
    mood: 'idle',
    setMood(m) {
      const next = MOODS.includes(m) ? m : 'idle';
      if (next === api.mood) return;
      el.classList.remove('ge-m-' + api.mood);
      el.classList.add('ge-m-' + next);
      api.mood = next;
    },
    destroy() { el.remove(); },
  };
  return api;
}
