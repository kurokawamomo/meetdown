// Avatar taste "flat": calm, premium flat vector animals. Solid shapes, no outlines, no texture.
//
// create({ seed, look, label }) -> { el, mood, setMood(mood), destroy() }
//   el        an <svg> (viewBox 0 0 240 240) that fills the square box its parent gives it
//   setMood   swaps one class on the root (fl-m-<mood>); every part stays in the DOM and CSS (prefix fl-) does the rest
//   look      optional overrides: { species, color, accessory, accessoryColor }
//             species fox | cat | bear | rabbit | owl, color '#rrggbb', accessory bowtie | ribbon | glasses | scarf | hat | none.
//             Everything else (blink tempo, glance side, ear twitch) comes from a stable hash of `seed`.
// traitsOf({ seed, look }) returns the chosen traits without touching the DOM.
//
// Design rules: big head on a small body; solid bead eyes (white discs for the owl) with one highlight; eyelids are a
// body-colored cover that closes from the top down; brows only appear when a mood needs them; the idle face is a soft
// neutral smile with slow blinks and a rare glance, nothing bounces.

import { MOODS } from './mood.js';

export const id = 'flat';
export const SPECIES = ['fox', 'cat', 'bear', 'rabbit', 'owl'];
export const ACCESSORIES = ['bowtie', 'ribbon', 'glasses', 'scarf', 'hat', 'none'];

const COLORS = ['#f2a7a3', '#f4a259', '#8fb8de', '#9bc5a1', '#c3a6e0', '#f2cb61', '#7fc8c0', '#e8927c', '#a9b4c8', '#d4aa86'];
const ACCENTS = ['#ef5350', '#ffc83d', '#4aa3f0', '#7c5cc4', '#22a99a', '#ff7a45'];

let serial = 0;
let instances = 0;

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

const f1 = (n) => Math.round(n * 10) / 10;
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
  const rnd = mulberry32(hash32('fl|' + String(seed)));
  const r = Array.from({ length: 16 }, rnd); // fixed draw order: overriding one trait never shifts the others
  const l = look || {};
  const species = SPECIES.includes(l.species) ? l.species : SPECIES[Math.floor(r[0] * SPECIES.length)];
  const accessory = ACCESSORIES.includes(l.accessory) ? l.accessory : ACCESSORIES[Math.floor(r[1] * ACCESSORIES.length)];
  const color = toHsl(l.color) || toHsl(COLORS[Math.floor(r[2] * COLORS.length)]);
  let accent = ACCENTS[Math.floor(r[3] * ACCENTS.length)];
  const ah = toHsl(accent).h;
  if (Math.abs(((ah - color.h + 540) % 360) - 180) < 28) accent = ACCENTS[(ACCENTS.indexOf(accent) + 3) % ACCENTS.length];
  const accessoryColor = toHsl(l.accessoryColor) ? toHsl(l.accessoryColor).hex : accent;
  return { key: String(seed), species, accessory, color, accessoryColor, r };
}

function paletteOf({ h, s, l, hex }, accessoryColor, accessory, custom) {
  const a = toHsl(accessoryColor);
  const black = accessory === 'bowtie' && !custom;
  const bow = black ? '#1d1d24' : accessoryColor;
  return {
    base: hex,
    dark: hsl(h, s + 6, l - 13),
    light: hsl(h, clamp(s * 0.5, 16, 50), 94),
    inner: hsl(h, clamp(s * 0.9, 30, 70), clamp(l + 8, 78, 90)),
    blush: hsl(h - 6, clamp(s + 10, 40, 85), clamp(l - 6, 55, 78)),
    ink: hsl(h, 32, 15),
    bow,
    bowDark: black ? '#3a3a45' : hsl(a.h, a.s, a.l - 16),
  };
}

// Per-species layout. cy/rx/ry describe the head; ey/es the eye line and half-spacing; ny the nose; sh a sideways shift
// that balances a big tail.
const SP = {
  fox: { ey: 115, es: 40, ny: 141, sh: -12, top: 50 },
  cat: { ey: 122, es: 42, ny: 142, sh: -6, top: 54 },
  bear: { ey: 124, es: 43, ny: 142, sh: 0, top: 52 },
  rabbit: { ey: 128, es: 37, ny: 145, sh: -6, top: 62 },
  owl: { ey: 112, es: 36, ny: 128, sh: 0, top: 48 },
};

const mirror = (inner) => `<g transform="translate(240 0) scale(-1 1)">${inner}</g>`;
const soft = (fill, w = 9) => `fill="${fill}" stroke="${fill}" stroke-width="${w}" stroke-linejoin="round"`;

const HEAD_D = {
  fox: 'M120 52 C162 52 192 74 198 106 Q201 120 207 133 Q211 142 203 147 C185 162 156 178 120 178 C84 178 55 162 37 147 Q29 142 33 133 Q39 120 42 106 C48 74 78 52 120 52 Z',
  cat: 'M120 54 C168 54 200 80 200 118 C200 154 168 178 120 178 C72 178 40 154 40 118 C40 80 72 54 120 54 Z',
  bear: 'M120 52 C168 52 200 80 200 118 C200 154 168 178 120 178 C72 178 40 154 40 118 C40 80 72 52 120 52 Z',
  rabbit: 'M120 62 C164 62 192 88 192 124 C192 158 164 178 120 178 C76 178 48 158 48 124 C48 88 76 62 120 62 Z',
  owl: 'M120 48 C170 48 202 76 202 116 C202 154 170 178 120 178 C70 178 38 154 38 116 C38 76 70 48 120 48 Z',
};

function earsSvg(sp, p) {
  let left = '';
  let ox = 84;
  let oy = 90;
  if (sp === 'fox') {
    left = `<path d="M50 104 Q36 56 52 16 Q92 30 118 66 Z" ${soft(p.base, 8)}/><path d="M63 88 Q55 58 61 38 Q82 48 98 70 Z" ${soft(p.inner, 6)}/>`;
  } else if (sp === 'cat') {
    left = `<path d="M50 98 Q42 66 56 38 Q84 46 106 68 Z" ${soft(p.base, 8)}/><path d="M62 86 Q58 66 64 52 Q80 58 94 70 Z" ${soft(p.inner, 6)}/>`;
  } else if (sp === 'bear') {
    left = `<circle cx="60" cy="70" r="23" fill="${p.base}"/><circle cx="62" cy="72" r="12" fill="${p.inner}"/>`;
    ox = 66; oy = 78;
  } else if (sp === 'rabbit') {
    left = `<g transform="rotate(-8 90 80)"><ellipse cx="90" cy="44" rx="16" ry="40" fill="${p.base}"/><ellipse cx="90" cy="48" rx="8" ry="27" fill="${p.inner}"/></g>`;
    ox = 90; oy = 82;
  } else {
    left = `<path d="M50 80 L46 32 L98 58 Z" ${soft(p.dark, 9)}/>`;
  }
  return `<g class="fl-ear fl-ear-l" style="transform-origin:${ox}px ${oy}px">${left}</g>` +
    `<g class="fl-ear fl-ear-r" style="transform-origin:${240 - ox}px ${oy}px">${mirror(left)}</g>`;
}

function tailSvg(sp, p, n) {
  if (sp === 'fox') {
    const d = 'M160 224 C214 240 252 208 246 150 C242 114 224 90 202 86 C206 140 194 186 156 198 Z';
    return `<clipPath id="fl-tt${n}"><circle cx="230" cy="86" r="44"/></clipPath><g class="fl-tail" style="transform-origin:164px 210px">` +
      `<path d="${d}" ${soft(p.base, 6)}/><g clip-path="url(#fl-tt${n})"><path d="${d}" ${soft(p.light, 6)}/></g></g>`;
  }
  if (sp === 'cat') {
    return `<g class="fl-tail" style="transform-origin:170px 216px"><path d="M168 218 C220 226 236 188 220 150" fill="none" stroke="${p.base}" stroke-width="22" stroke-linecap="round"/>` +
      `<path d="M226 168 C220 156 220 150 220 150" fill="none" stroke="${p.dark}" stroke-width="22" stroke-linecap="round"/></g>`;
  }
  if (sp === 'rabbit') {
    return `<g class="fl-tail" style="transform-origin:180px 216px"><circle cx="184" cy="212" r="20" fill="${p.light}"/></g>`;
  }
  return '';
}

function faceMarks(sp, p) {
  if (sp === 'fox') {
    return `<path d="M0 146 C44 124 84 132 104 146 Q120 158 136 146 C156 132 196 124 240 146 L240 200 L0 200 Z" fill="${p.light}"/>`;
  }
  if (sp === 'cat') {
    return `<ellipse cx="120" cy="150" rx="34" ry="22" fill="${p.light}"/>` +
      `<path d="M120 62 v16 M104 65 l3 13 M136 65 l-3 13" stroke="${p.dark}" stroke-width="5" stroke-linecap="round" fill="none"/>`;
  }
  if (sp === 'bear') return `<ellipse cx="120" cy="150" rx="32" ry="24" fill="${p.light}"/>`;
  if (sp === 'rabbit') return `<ellipse cx="108" cy="152" rx="20" ry="16" fill="${p.light}"/><ellipse cx="132" cy="152" rx="20" ry="16" fill="${p.light}"/>`;
  return `<ellipse cx="84" cy="112" rx="36" ry="38" fill="${p.light}"/><ellipse cx="156" cy="112" rx="36" ry="38" fill="${p.light}"/>`;
}

function noseSvg(sp, p) {
  const y = SP[sp].ny;
  if (sp === 'fox') return `<path d="M111 ${y - 5} Q120 ${y - 10} 129 ${y - 5} Q127 ${y + 4} 120 ${y + 6} Q113 ${y + 4} 111 ${y - 5} Z" ${soft(p.ink, 3)}/>`;
  if (sp === 'cat') return `<path d="M113 ${y - 3} Q120 ${y - 6} 127 ${y - 3} Q124 ${y + 4} 120 ${y + 5} Q116 ${y + 4} 113 ${y - 3} Z" ${soft(p.blush, 3)}/>`;
  if (sp === 'bear') return `<ellipse cx="120" cy="${y - 2}" rx="11" ry="8" fill="${p.ink}"/>`;
  if (sp === 'rabbit') return `<path d="M113 ${y - 5} Q120 ${y - 8} 127 ${y - 5} Q124 ${y + 3} 120 ${y + 4} Q116 ${y + 3} 113 ${y - 5} Z" ${soft(p.blush, 3)}/>`;
  return `<path d="M110 ${y - 6} Q120 ${y - 12} 130 ${y - 6} Q125 ${y + 10} 120 ${y + 12} Q115 ${y + 10} 110 ${y - 6} Z" ${soft('#f2b134', 4)}/>`;
}

function mouthSvg(sp, p) {
  const y = SP[sp].ny;
  if (sp === 'owl') {
    return `<g class="fl-beak-low"><path d="M112 ${y + 8} Q120 ${y + 4} 128 ${y + 8} Q124 ${y + 20} 120 ${y + 21} Q116 ${y + 20} 112 ${y + 8} Z" ${soft('#e1982a', 3)}/></g>`;
  }
  const my = y + 6;
  const smile = sp === 'bear' || sp === 'rabbit'
    ? `M109 ${my + 1} Q120 ${my + 12} 131 ${my + 1}`
    : `M107 ${my} Q113.5 ${my + 8} 120 ${my} Q126.5 ${my + 8} 133 ${my}`;
  const stem = `M120 ${y + 3} V${my}`;
  return `<g class="fl-mouth"><path d="${stem}" stroke="${p.ink}" stroke-width="3.6" stroke-linecap="round" fill="none"/>` +
    `<path class="fl-mo-smile" d="${smile}" fill="none" stroke="${p.ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<g class="fl-mo-open"><path d="M107 ${my} Q120 ${my + 4} 133 ${my} Q131 ${my + 28} 120 ${my + 28} Q109 ${my + 28} 107 ${my} Z" fill="${p.ink}"/>` +
    `<ellipse cx="120" cy="${my + 22}" rx="9" ry="5.5" fill="#ef7f86"/></g>` +
    `<ellipse class="fl-mo-o" cx="120" cy="${my + 8}" rx="8" ry="10" fill="${p.ink}"/>` +
    `<path class="fl-mo-flat" d="M110 ${my + 4} Q121 ${my} 132 ${my + 6}" fill="none" stroke="${p.ink}" stroke-width="4" stroke-linecap="round"/></g>`;
}

function eyeSvg(cx, cy, sp, p, n, idx) {
  const owl = sp === 'owl';
  const R = owl ? 26 : 12.5;
  const cid = `fl-e${n}-${idx}`;
  const clip = owl ? `<circle cx="${cx}" cy="${cy}" r="${R}"/>` : `<ellipse cx="${cx}" cy="${cy}" rx="${R + 2.5}" ry="${R + 2.5}"/>`;
  const lidBase = cy - R - 6;
  const ball = owl
    ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#fff"/><g class="fl-pupil"><ellipse cx="${cx}" cy="${cy + 1}" rx="12" ry="13.5" fill="${p.ink}"/>` +
      `<circle cx="${cx + 4.5}" cy="${cy - 4.5}" r="4.2" fill="#fff"/></g>`
    : `<g class="fl-pupil"><ellipse cx="${cx}" cy="${cy}" rx="10" ry="12" fill="${p.ink}"/><circle cx="${cx + 3.6}" cy="${cy - 4.4}" r="3.4" fill="#fff"/></g>`;
  return `<clipPath id="${cid}">${clip}</clipPath>` +
    `<g class="fl-eye"><g class="fl-gaze">${ball}</g>` +
    `<g clip-path="url(#${cid})"><path class="fl-lid" d="M${cx - R - 8} ${lidBase - 60} H${cx + R + 8} V${lidBase} Q${cx} ${lidBase + 9} ${cx - R - 8} ${lidBase} Z" fill="${p.base}"/></g>` +
    `<path class="fl-shut" d="M${cx - 12} ${cy} Q${cx} ${cy + 9} ${cx + 12} ${cy}" fill="none" stroke="${p.ink}" stroke-width="4" stroke-linecap="round"/></g>`;
}

function accessoryHeadSvg(acc, p, sp) {
  const { ey, es, top } = SP[sp];
  if (acc === 'glasses') {
    const r = sp === 'owl' ? 31 : 23;
    const bridge = es - r;
    return `<g fill="#fff" fill-opacity=".12" stroke="${p.ink}" stroke-width="4.5"><circle cx="${120 - es}" cy="${ey}" r="${r}"/><circle cx="${120 + es}" cy="${ey}" r="${r}"/></g>` +
      `<path d="M${120 - bridge} ${ey - 2} Q120 ${ey - 8} ${120 + bridge} ${ey - 2}" fill="none" stroke="${p.ink}" stroke-width="4.5" stroke-linecap="round"/>`;
  }
  if (acc === 'hat') {
    return `<g transform="translate(120 ${top + 8}) rotate(11)">` +
      `<path d="M-17 2 L0 -44 L17 2 Z" ${soft(p.bow, 6)}/>` +
      `<path d="M-19 4 L-16 -6 L16 -6 L19 4 Z" ${soft(p.bowDark, 4)}/><circle cx="0" cy="-47" r="7.5" fill="#fff"/></g>`;
  }
  if (acc === 'ribbon') {
    const pos = { fox: [186, 84], cat: [176, 78], bear: [170, 82], rabbit: [166, 92], owl: [120, 56] }[sp];
    return `<g transform="translate(${pos[0]} ${pos[1]}) rotate(${sp === 'owl' ? 0 : 22})"><path d="M0 0 C-8 -16 -28 -13 -27 0 C-28 13 -8 16 0 0Z" fill="${p.bow}"/>` +
      `<path d="M0 0 C8 -16 28 -13 27 0 C28 13 8 16 0 0Z" fill="${p.bow}"/><circle r="6.5" fill="${p.bowDark}"/></g>`;
  }
  return '';
}

function accessoryBodySvg(acc, p) {
  if (acc === 'bowtie') {
    return `<g ${soft(p.bow, 6)}><path d="M120 190 L90 176 L90 204 Z"/><path d="M120 190 L150 176 L150 204 Z"/></g>` +
      `<rect x="111" y="180" width="18" height="20" rx="7" fill="${p.bowDark}"/>`;
  }
  if (acc === 'scarf') {
    return `<path d="M148 204 L162 232 L142 234 L132 208 Z" ${soft(p.bowDark, 4)}/>` +
      `<path d="M62 184 Q120 212 178 184 L178 202 Q120 232 62 202 Z" ${soft(p.bow, 4)}/>`;
  }
  return '';
}

function buildSvg(t, n, label) {
  const { species: sp, accessory: acc } = t;
  const p = paletteOf(t.color, t.accessoryColor, acc, t.customAcc);
  const g = SP[sp];
  const { ey, es } = g;
  const ink = p.ink;
  const bodyD = 'M60 180 C60 168 84 164 120 164 C156 164 180 168 180 180 L184 206 C184 220 168 228 120 228 C72 228 56 220 56 206 Z';
  const owl = sp === 'owl';
  const belly = owl
    ? `<ellipse cx="120" cy="206" rx="40" ry="34" fill="${p.light}"/>`
    : `<ellipse cx="120" cy="214" rx="30" ry="26" fill="${p.light}"/>`;
  const paw = (cx) => owl
    ? `<ellipse cx="${cx}" cy="226" rx="15" ry="7" fill="#e1982a"/>`
    : `<ellipse cx="${cx}" cy="216" rx="15" ry="11" fill="${p.light}"/>`;
  const wings = owl ? `<path d="M64 176 Q42 196 60 220 Q78 216 82 188 Z" ${soft(p.dark, 5)}/>${mirror(`<path d="M64 176 Q42 196 60 220 Q78 216 82 188 Z" ${soft(p.dark, 5)}/>`)}` : '';
  const brow = (cls, cx) => `<path class="fl-brow ${cls}" d="M${cx - 13} ${ey - 28} Q${cx} ${ey - 36} ${cx + 13} ${ey - 28}" fill="none" stroke="${ink}" stroke-width="4.4" stroke-linecap="round" style="transform-origin:${cx}px ${ey - 30}px"/>`;
  const dotFill = '#e6e9f5';
  const z = (x, y, s, k) => `<g transform="translate(${x} ${y}) scale(${s})"><path class="fl-z fl-z-${k}" d="M0 0 H12 L0 14 H12" fill="none" stroke="${dotFill}" stroke-width="${f1(3.4 / s)}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  const wave = (k) => `<path class="fl-wave fl-wave-${k}" d="M${30 - k * 9 + g.sh} ${106 - k * 6} Q${22 - k * 9 + g.sh} 120 ${30 - k * 9 + g.sh} ${134 + k * 6}" fill="none" stroke="${dotFill}" stroke-width="4" stroke-linecap="round"/>`;
  const headFill = `fill="${p.base}"`;

  return `<svg class="fl-root fl-sp-${sp} fl-m-idle" viewBox="0 0 240 240" role="img" aria-label="${String(label || '').replace(/[<>&"]/g, '')}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><clipPath id="fl-h${n}"><path d="${HEAD_D[sp]}"/></clipPath><clipPath id="fl-b${n}"><path d="${bodyD}"/></clipPath></defs>` +
    `<rect x="${64 + g.sh}" y="224" width="112" height="9" rx="4.5" fill="#000" opacity=".2"/>` +
    `<g class="fl-fx"><g class="fl-thinkfx"><circle class="fl-dot fl-dot-1" cx="${204 + g.sh}" cy="74" r="4" fill="${dotFill}"/><circle class="fl-dot fl-dot-2" cx="${218 + g.sh}" cy="56" r="5.5" fill="${dotFill}"/><circle class="fl-dot fl-dot-3" cx="${234 + g.sh}" cy="32" r="7.5" fill="${dotFill}"/></g>` +
    `<g class="fl-bang"><path d="M214 14 L214 42" stroke="#ffc83d" stroke-width="9" stroke-linecap="round"/><circle cx="214" cy="60" r="5.5" fill="#ffc83d"/></g>` +
    `${z(206 + g.sh, 66, 1, 1)}${z(220 + g.sh, 44, 1.35, 2)}${z(232 + g.sh, 18, 1.7, 3)}${wave(0)}${wave(1)}</g>` +
    `<g class="fl-hop"><g transform="translate(${g.sh} 0)">` +
    tailSvg(sp, p, n) +
    `<g class="fl-body">${wings}<path d="${bodyD}" fill="${p.base}"/><g clip-path="url(#fl-b${n})">${belly}<ellipse cx="120" cy="172" rx="70" ry="16" fill="${p.dark}"/></g>` +
    `<g class="fl-paw-l">${paw(90)}</g><g class="fl-paw-r">${paw(150)}</g>${accessoryBodySvg(acc, p)}</g>` +
    `<g class="fl-head">${earsSvg(sp, p)}` +
    `<path d="${HEAD_D[sp]}" ${headFill}/>` +
    `<g clip-path="url(#fl-h${n})">${faceMarks(sp, p)}</g>` +
    `<ellipse class="fl-blush" cx="${120 - es - 18}" cy="${ey + (sp === 'fox' ? 27 : 22)}" rx="11" ry="7" fill="${p.blush}"/><ellipse class="fl-blush" cx="${120 + es + 18}" cy="${ey + (sp === 'fox' ? 27 : 22)}" rx="11" ry="7" fill="${p.blush}"/>` +
    noseSvg(sp, p) + mouthSvg(sp, p) +
    `<g class="fl-eyes">${eyeSvg(120 - es, ey, sp, p, n, 0)}${eyeSvg(120 + es, ey, sp, p, n, 1)}</g>` +
    `${brow('fl-brow-l', 120 - es)}${brow('fl-brow-r', 120 + es)}` +
    accessoryHeadSvg(acc, p, sp) +
    `</g>` +
    `<g class="fl-armup"><path d="M170 210 L160 182" fill="none" stroke="${p.base}" stroke-width="27" stroke-linecap="round"/>` +
    `<circle cx="158" cy="176" r="16" fill="${p.light}"/></g>` +
    `</g></g></svg>`;
}

const CSS = `
.fl-root{display:block;width:100%;height:100%;overflow:visible;--ld:3px;--lc:42px}
.fl-sp-owl{--ld:6px;--lc:72px}
.fl-hop,.fl-head,.fl-body,.fl-ear,.fl-tail,.fl-brow,.fl-gaze,.fl-pupil,.fl-armup,.fl-beak-low,.fl-lid,.fl-mo-open,.fl-mo-smile,.fl-mo-o,.fl-mo-flat,.fl-paw-r,.fl-blush{transition:transform .4s ease,opacity .3s ease,filter .5s ease}
.fl-hop{transform-origin:120px 228px}
.fl-head{transform-origin:120px 172px}
.fl-body{transform-origin:120px 228px}
.fl-pupil,.fl-gaze,.fl-brow,.fl-mo-open,.fl-mo-smile,.fl-mo-o,.fl-mo-flat,.fl-dot,.fl-bang,.fl-beak-low,.fl-blush{transform-box:fill-box;transform-origin:50% 50%}
.fl-mo-open{transform-origin:50% 0}
.fl-bang{transform-origin:50% 100%}
.fl-lid{transform:translateY(var(--ld));animation:fl-blink var(--fl-blink,6s) ease-in-out var(--fl-blinkd,0s) infinite}
.fl-shut{opacity:0}
.fl-brow{opacity:0}
.fl-blush{opacity:.5}
.fl-mo-open,.fl-mo-o,.fl-mo-flat{opacity:0}
.fl-fx>g,.fl-armup{opacity:0}
.fl-wave,.fl-z,.fl-dot{opacity:0}
.fl-bang{transform:scale(0)}
.fl-tail{animation:fl-sway 6s ease-in-out infinite alternate}
.fl-armup{transform:translateY(18px)}
.fl-ear-r{animation:fl-twitch var(--fl-tw,11s) ease-in-out var(--fl-twd,0s) infinite}
.fl-body{animation:fl-breathe 5s ease-in-out infinite alternate}

.fl-m-idle .fl-gaze{animation:fl-glance var(--fl-glance,13s) ease-in-out var(--fl-glanced,0s) infinite}

.fl-m-speaking{--ld:0px}
.fl-m-speaking .fl-mo-smile{opacity:0}
.fl-m-speaking .fl-mo-open{opacity:1;animation:fl-talk .55s ease-in-out infinite}
.fl-m-speaking .fl-beak-low{animation:fl-beak .55s ease-in-out infinite}
.fl-m-speaking .fl-head{animation:fl-bob 1.3s ease-in-out infinite alternate}
.fl-m-speaking .fl-tail{animation-duration:2.4s}

.fl-m-thinking{--ld:5px}
.fl-m-thinking .fl-head{transform:rotate(-5deg) translate(-2px,1px)}
.fl-m-thinking .fl-gaze{transform:translate(5px,-6px)}
.fl-m-thinking .fl-mo-smile{opacity:0}
.fl-m-thinking .fl-mo-flat{opacity:1}
.fl-m-thinking .fl-brow-l{opacity:.8;transform:translateY(2px) rotate(6deg)}
.fl-m-thinking .fl-brow-r{opacity:.9;transform:translateY(-6px) rotate(-7deg)}
.fl-m-thinking .fl-armup{opacity:1;transform:none}
.fl-m-thinking .fl-paw-r{opacity:0}
.fl-m-thinking .fl-thinkfx{opacity:1}
.fl-m-thinking .fl-dot{animation:fl-dot 1.8s ease-in-out infinite}
.fl-m-thinking .fl-dot-2{animation-delay:.25s}
.fl-m-thinking .fl-dot-3{animation-delay:.5s}
.fl-m-thinking .fl-tail{animation-duration:9s}

.fl-m-listening{--ld:0px}
.fl-m-listening .fl-head{animation:fl-nod 3.6s ease-in-out infinite}
.fl-m-listening .fl-pupil{transform:scale(1.08)}
.fl-m-listening .fl-brow{opacity:.8;transform:translateY(-4px)}
.fl-m-listening .fl-ear-l{transform:rotate(-5deg)}
.fl-m-listening .fl-ear-r{animation:none;transform:rotate(5deg)}
.fl-m-listening .fl-mo-smile{transform:scale(1.12)}
.fl-m-listening .fl-fx{opacity:1}
.fl-m-listening .fl-wave{animation:fl-wave 1.8s ease-out infinite}
.fl-m-listening .fl-wave-1{animation-delay:.4s}

.fl-m-surprised{--ld:-2px}
.fl-m-surprised .fl-lid{animation:none}
.fl-m-surprised .fl-pupil{transform:scale(1.22)}
.fl-sp-owl.fl-m-surprised .fl-pupil{transform:scale(.62)}
.fl-m-surprised .fl-brow{opacity:1;transform:translateY(-9px)}
.fl-m-surprised .fl-mo-smile{opacity:0}
.fl-m-surprised .fl-mo-o{opacity:1}
.fl-m-surprised .fl-beak-low{transform:translateY(6px)}
.fl-m-surprised .fl-hop{animation:fl-hop 1.2s ease-out 1 both}
.fl-m-surprised .fl-ear{transform:translateY(-5px)}
.fl-m-surprised .fl-ear-r{animation:none}
.fl-m-surprised .fl-bang{opacity:1;animation:fl-pop .5s cubic-bezier(.3,1.6,.5,1) both}
.fl-m-surprised .fl-tail{animation-duration:1s}

.fl-m-away{--ld:var(--lc)}
.fl-m-away .fl-lid{animation:none}
.fl-m-away .fl-shut{opacity:1}
.fl-m-away .fl-hop{filter:saturate(.55) brightness(.74)}
.fl-m-away .fl-head{transform:rotate(3deg) translateY(7px)}
.fl-m-away .fl-ear-l{transform:rotate(-8deg)}
.fl-m-away .fl-ear-r{animation:none;transform:rotate(8deg)}
.fl-m-away .fl-tail,.fl-m-away .fl-body{animation:none}
.fl-m-away .fl-mo-smile{transform:scaleX(.75)}
.fl-m-away .fl-blush{opacity:.2}
.fl-m-away .fl-fx{opacity:1}
.fl-m-away .fl-z{animation:fl-z 3.6s ease-out infinite}
.fl-m-away .fl-z-2{animation-delay:1.2s}
.fl-m-away .fl-z-1{animation-delay:2.4s}

@keyframes fl-blink{0%,94%{transform:translateY(var(--ld))}96.5%{transform:translateY(var(--lc))}100%{transform:translateY(var(--ld))}}
@keyframes fl-glance{0%,30%{transform:translate(0,0)}35%,48%{transform:translate(var(--fl-gx,6px),0)}54%,100%{transform:translate(0,0)}}
@keyframes fl-talk{0%{transform:scaleY(.3)}14%{transform:scaleY(1)}33%{transform:scaleY(.35)}47%{transform:scaleY(.75)}66%{transform:scaleY(.3)}80%{transform:scaleY(.9)}100%{transform:scaleY(.3)}}
@keyframes fl-beak{0%{transform:translateY(0)}14%{transform:translateY(8px)}33%{transform:translateY(1px)}47%{transform:translateY(5px)}66%{transform:translateY(0)}80%{transform:translateY(7px)}100%{transform:translateY(0)}}
@keyframes fl-bob{from{transform:rotate(-.8deg) translateY(0)}to{transform:rotate(.8deg) translateY(-1.5px)}}
@keyframes fl-nod{0%,100%{transform:translateY(0) rotate(0)}10%{transform:translateY(5px) rotate(1.2deg)}22%{transform:translateY(0) rotate(0)}34%{transform:translateY(4px) rotate(.8deg)}46%{transform:translateY(0) rotate(0)}}
@keyframes fl-hop{0%{transform:translateY(0) scale(1,1)}8%{transform:scale(1.03,.95)}24%{transform:translateY(-16px) scale(.98,1.03)}44%{transform:translateY(0) scale(1.03,.96)}58%{transform:translateY(-6px)}72%,100%{transform:translateY(0) scale(1,1)}}
@keyframes fl-pop{0%{transform:scale(0)}100%{transform:scale(1)}}
@keyframes fl-dot{0%,100%{opacity:.25;transform:scale(.7)}45%{opacity:1;transform:scale(1.1)}}
@keyframes fl-wave{0%{opacity:0;transform:translateX(5px)}30%{opacity:.85}100%{opacity:0;transform:translateX(-6px)}}
@keyframes fl-z{0%{opacity:0;transform:translate(0,8px)}20%{opacity:1}75%{opacity:1}100%{opacity:0;transform:translate(6px,-12px)}}
@keyframes fl-sway{from{transform:rotate(-2deg)}to{transform:rotate(3deg)}}
@keyframes fl-twitch{0%,92%,100%{transform:rotate(0)}95%{transform:rotate(6deg)}97.5%{transform:rotate(-1.5deg)}}
@keyframes fl-breathe{from{transform:scaleY(1)}to{transform:scaleY(1.012)}}
@media (prefers-reduced-motion:reduce){.fl-root *{animation:none!important}}
`;

function ensureStyle() {
  if (document.getElementById('fl-style')) return;
  const s = document.createElement('style');
  s.id = 'fl-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function create({ seed = '', look = {}, label = '' } = {}) {
  const t = traitsOf({ seed, look });
  t.customAcc = !!(look && toHsl(look.accessoryColor));
  ensureStyle();
  const n = ++serial;
  instances++;
  const host = document.createElement('div');
  host.innerHTML = buildSvg(t, n, label);
  const el = host.firstElementChild;
  const r = t.r;
  el.setAttribute('style', [
    `--fl-blink:${f1(5 + r[4] * 4)}s`, `--fl-blinkd:${-f1(r[5] * 8)}s`,
    `--fl-glance:${f1(11 + r[6] * 8)}s`, `--fl-glanced:${-f1(r[7] * 10)}s`, `--fl-gx:${r[8] < 0.5 ? -6 : 6}px`,
    `--fl-tw:${f1(9 + r[11] * 8)}s`, `--fl-twd:${-f1(r[12] * 9)}s`,
  ].join(';'));
  let mood = 'idle';
  return {
    el,
    get mood() { return mood; },
    setMood(m) {
      if (!MOODS.includes(m) || m === mood) return;
      el.classList.replace('fl-m-' + mood, 'fl-m-' + m);
      mood = m;
    },
    destroy() {
      el.remove();
      instances = Math.max(0, instances - 1);
      if (!instances) { const s = document.getElementById('fl-style'); if (s) s.remove(); }
    },
  };
}
