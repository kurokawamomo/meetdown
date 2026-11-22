// Avatar taste "pixel": a plush ball (head and body in one, no limbs) on a 32 x 32 grid, drawn as SVG rects and
// animated by frame swapping. Parts and colours are recombined from the seed (the participant name), so a name always
// gets the same character and every name gets a different mix.
//
// create({ seed, look, label }) -> { el, mood, setMood(mood), destroy() }
//   el      an <svg> that fills the square box its parent gives it; the viewBox is recomputed on resize so one art pixel
//           is always a whole number of device pixels (crisp edges, equal pixel sizes)
//   setMood swaps one class on the root; every frame stays in the DOM and CSS (prefix px-) toggles visibility in steps
//   look    optional overrides, each one independent:
//           seed       any string; replaces the name as the seed (change it to get a new character)
//           species    preset for ears + tail: fox | cat | bear | rabbit | owl | dog | mouse
//           ears       one of EARS, tail one of TAILS, whiskers true | false
//           accessory  one of ACCESSORIES, color / accessoryColor '#rrggbb'
// traitsOf({ seed, look }) returns the chosen traits without touching the DOM.

import { MOODS } from './mood.js';

export const id = 'pixel';
export const EARS = ['fox', 'cat', 'bear', 'rabbit', 'owl', 'dog', 'mouse', 'sprout', 'none'];
export const TAILS = ['plume', 'curl', 'puff', 'none'];
export const ACCESSORIES = ['bowtie', 'ribbon', 'glasses', 'scarf', 'hat', 'flower', 'none'];
const PRESETS = {
  fox: { ears: 'fox', tail: 'plume' },
  cat: { ears: 'cat', tail: 'curl', whiskers: true },
  bear: { ears: 'bear', tail: 'none' },
  rabbit: { ears: 'rabbit', tail: 'puff' },
  owl: { ears: 'owl', tail: 'none' },
  dog: { ears: 'dog', tail: 'curl' },
  mouse: { ears: 'mouse', tail: 'curl' },
};
export const SPECIES = Object.keys(PRESETS);

const N = 32;
const HUES = [350, 12, 28, 44, 140, 168, 190, 208, 230, 262, 290, 322];
const SVGNS = 'http://www.w3.org/2000/svg';
let styleInjected = false;

// ---------- seeded helpers ----------

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
const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 3, 98))}%)`;

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
  return { h, s: s * 100, l: l * 100 };
}

// Move hue h toward `target` along the shorter arc by at most `amount` degrees (hue shifting).
function toward(h, target, amount) {
  let d = ((target - h + 540) % 360) - 180;
  d = clamp(d, -amount, amount);
  return h + d;
}

const pick = (list, x) => list[Math.floor(x * list.length)];

export function traitsOf({ seed = '', look = {} } = {}) {
  const l = look || {};
  const key = String(l.seed || seed);
  const rnd = mulberry32(hash32('px|' + key));
  const r = Array.from({ length: 16 }, rnd); // fixed draw order: overriding one trait never shifts the others
  const preset = PRESETS[l.species] || null;
  const ears = EARS.includes(l.ears) ? l.ears : preset ? preset.ears : pick(EARS, r[0]);
  const tail = TAILS.includes(l.tail) ? l.tail : preset ? preset.tail : pick(TAILS, r[9]);
  const whiskers = typeof l.whiskers === 'boolean' ? l.whiskers : preset ? !!preset.whiskers : r[10] < 0.25;
  const accessory = ACCESSORIES.includes(l.accessory) ? l.accessory : pick(ACCESSORIES, r[1]);
  const color = toHsl(l.color) || { h: HUES[Math.floor(r[2] * HUES.length)] + (r[3] - 0.5) * 12, s: 56 + r[4] * 18, l: 74 + r[5] * 6 };
  const accessoryColor = toHsl(l.accessoryColor) || (r[11] < 0.5 ? null : { h: HUES[Math.floor(r[12] * HUES.length)], s: 62, l: 62 });
  return {
    key,
    species: l.species || null,
    ears,
    tail,
    whiskers,
    accessory,
    color,
    accessoryColor,
    blinkEvery: 5.2 + r[6] * 2.4,
    blinkPhase: -(r[7] * 6),
    tailPhase: -(r[8] * 4),
  };
}

function paletteOf({ h, s, l }, accent) {
  const ah = accent ? accent.h : h + 150;
  const as = accent ? accent.s : 68;
  const al = accent ? accent.l : 60;
  return {
    h: hsl(toward(h, 50, 12), s - 6, l + 8),
    b: hsl(h, s, l),
    d: hsl(toward(h, 275, 16), s, l - 10),
    D: hsl(toward(h, 275, 24), s + 2, l - 20),
    o: hsl(toward(h, 285, 32), clamp(s * 0.8, 30, 62), 25),
    w: hsl(toward(h, 42, 40), 60, 94),
    c: hsl(toward(h, 42, 36), 48, 84),
    p: hsl(toward(h, 352, 18), 70, 88),
    r: hsl(toward(h, 352, 14), 88, 72),
    k: '#2a2029',
    W: '#fff9f0',
    K: '#4b4452',
    g: '#6f6878',
    y: hsl(36, 88, 62),
    Y: hsl(24, 78, 48),
    a: hsl(ah, as, al),
    A: hsl(ah, as, al + 14),
    z: hsl(ah, as + 4, al - 14),
    t: '#e9788a',
    f: '#d9e6ff',
    i: hsl(toward(h, 30, 30) + 10, 62, 52),
    v: hsl(108, 50, 56),
    V: hsl(118, 46, 38),
  };
}

// ---------- raster helpers (32 x 32 grids of palette keys) ----------

const blank = () => Array.from({ length: N }, () => new Array(N).fill(null));
const inb = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

// Fill every pixel whose centre is inside the ellipse. `key` may be a function (px, py, u, v) -> key|null.
function ell(g, cx, cy, rx, ry, key, { rot = 0, n = 2 } = {}) {
  const ca = Math.cos((rot * Math.PI) / 180);
  const sa = Math.sin((rot * Math.PI) / 180);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (dx * ca + dy * sa) / rx;
      const v = (-dx * sa + dy * ca) / ry;
      if (Math.pow(Math.abs(u), n) + Math.pow(Math.abs(v), n) <= 1) {
        const k = typeof key === 'function' ? key(x, y, u, v) : key;
        if (k) g[y][x] = k;
      }
    }
  }
}

function tri(g, pts, key) {
  const [a, b, c] = pts;
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = [x + 0.5, y + 0.5];
      const d1 = sign(p, a, b);
      const d2 = sign(p, b, c);
      const d3 = sign(p, c, a);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) {
        const k = typeof key === 'function' ? key(x, y) : key;
        if (k) g[y][x] = k;
      }
    }
  }
}

const rect = (g, x, y, w, h, key) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (inb(i, j)) g[j][i] = key;
};

// Light from the top-left: a lower-right crescent in two steps, a small highlight on the upper-left rim.
function lit(u, v, hi = true) {
  const t = u * 0.62 + v * 0.78;
  const rim = Math.hypot(u, v);
  if (t > 0.9 && rim > 0.93) return 'D';
  if (t > 0.5 && rim > 0.84) return 'd';
  if (hi && t < -0.62 && rim > 0.86) return 'h';
  return 'b';
}

// Paint group grids bottom-up; each group gets a one-pixel outline (4-neighbour dilation) beneath it.
function stack(groups, out = blank()) {
  for (const g of groups) {
    const edge = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (g[y][x]) continue;
        if ((inb(x - 1, y) && g[y][x - 1]) || (inb(x + 1, y) && g[y][x + 1]) || (inb(x, y - 1) && g[y - 1][x]) || (inb(x, y + 1) && g[y + 1][x])) edge.push([x, y]);
      }
    }
    for (const [x, y] of edge) out[y][x] = 'o';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (g[y][x]) out[y][x] = g[y][x];
  }
  return out;
}

// ---------- ball, ears, tails ----------

const BCX = 16;
const BCY = 18.6;
const BRX = 10.8;
const BRY = 11.4;
const EYE_X = 9; // left eye column; the right eye mirrors it
const EYE_Y = 16;
const EYE_C = [[11.5, 18.5], [20.5, 18.5]]; // eye centres (owl discs, glasses)

const ball = (g) => ell(g, BCX, BCY, BRX, BRY, (x, y, u, v) => lit(u, v), { n: 2.05 });
const flat = (x, y, u, v) => lit(u, v, false);

// Ears behind the ball go to `under`; ears that hang over it go to `over` (outlined on top of the ball).
function earsOf(kind, under, over, face) {
  for (const m of [false, true]) {
    const P = (x, y) => [m ? N - x : x, y];
    const X = (x) => (m ? N - x : x);
    if (kind === 'fox') {
      tri(under, [P(6.8, 1.6), P(4.8, 13.6), P(14.4, 9.6)], 'b');
      tri(under, [P(7.2, 5.4), P(6.6, 12.6), P(11.4, 10.4)], 'p');
    } else if (kind === 'cat') {
      tri(under, [P(6.8, 2.6), P(5.0, 13.0), P(13.2, 9.6)], 'b');
      tri(under, [P(7.4, 6.2), P(6.6, 12.4), P(11.0, 10.4)], 'p');
    } else if (kind === 'bear') {
      ell(under, X(7.4), 9.6, 3.5, 3.4, flat);
      ell(under, X(7.6), 10.0, 1.7, 1.6, 'p');
    } else if (kind === 'rabbit') {
      const rot = m ? 10 : -10;
      ell(under, X(10.4), 5.4, 2.8, 8.0, flat, { rot });
      ell(under, X(10.6), 6.0, 1.3, 5.6, 'p', { rot });
    } else if (kind === 'owl') {
      tri(under, [P(6.2, 3.4), P(5.4, 12.0), P(12.6, 9.6)], 'd');
    } else if (kind === 'dog') {
      ell(over, X(6.4), 14.6, 2.7, 5.8, (x, y, u, v) => (lit(u, v, false) === 'b' ? 'd' : 'D'), { rot: m ? -16 : 16 });
    } else if (kind === 'mouse') {
      ell(under, X(7.0), 7.8, 4.6, 4.4, flat);
      ell(under, X(7.2), 8.2, 2.6, 2.4, 'p');
    }
  }
  if (kind === 'sprout') {
    rect(under, 16, 3, 1, 5, 'V');
    ell(under, 13.4, 4.0, 2.8, 1.4, 'v', { rot: -25 });
    ell(under, 19.6, 3.4, 2.8, 1.4, 'v', { rot: 25 });
  }
  if (kind === 'owl') {
    face.eyeDisc = true;
    face.beak = true;
    face.cheeks = false;
  }
}

function tailOf(kind, g) {
  if (kind === 'plume') {
    ell(g, 26.0, 19.0, 5.6, 10.2, (x, y, u, v) => {
      const k = lit(u, v);
      if (v < -0.6) return k === 'd' || k === 'D' ? 'c' : 'w';
      return k;
    }, { rot: 16 });
  } else if (kind === 'curl') {
    const pts = [[25, 28], [28, 27], [29.5, 24], [29.5, 20.5], [28.5, 17.5], [29.5, 15]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      for (let t = 0; t <= 1; t += 0.05) ell(g, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1.9, 1.9, flat);
    }
  } else if (kind === 'puff') {
    ell(g, 27.4, 26.4, 3.4, 3.4, (x, y, u, v) => (lit(u, v, false) === 'b' ? 'w' : 'c'));
  } else return false;
  return true;
}

function partsOf(traits) {
  const tail = blank();
  const body = blank();
  const over = blank();
  const face = { eyeDisc: false, beak: false, cheeks: true };
  earsOf(traits.ears, body, over, face);
  ball(body);
  if (face.eyeDisc) for (const [cx, cy] of EYE_C) ell(body, cx, cy, 3.9, 3.9, 'w');
  if (traits.whiskers && !face.beak) {
    for (const [x, y] of [[2, 20], [3, 21], [4, 21], [2, 24], [3, 23], [4, 23]]) { body[y][x] = 'W'; body[y][N - 1 - x] = 'W'; }
  }
  const hasTail = tailOf(traits.tail, tail);
  return { tail: hasTail ? tail : null, body, over, face };
}

// ---------- accessories ----------

function bowtie() {
  const g = blank();
  const rows = ['kk....', 'kgkk.k', 'kkkkKk', 'kkkk.k', 'kk....'];
  rows.forEach((row, j) => {
    for (let i = 0; i < 6; i++) {
      const ch = row[i];
      if (ch === '.') continue;
      g[25 + j][10 + i] = ch;
      g[25 + j][N - 1 - (10 + i)] = ch === 'g' ? 'k' : ch;
    }
  });
  return { over: g };
}

function scarf() {
  const g = blank();
  ell(g, 16, 26.2, 10.0, 2.2, (x, y, u, v) => (v > 0.4 ? 'z' : y === 24 && ((x >> 1) & 1) ? 'A' : 'a'), { n: 2.6 });
  rect(g, 20, 27, 3, 3, 'a');
  rect(g, 20, 29, 3, 1, 'z');
  g[28][21] = 'A';
  return { over: g, clip: true };
}

function ribbon() {
  const g = blank();
  const wing = ['.AAAA', 'AaaAa', 'aaaaa', 'zaaaa', '.zzza'];
  wing.forEach((row, j) => {
    for (let i = 0; i < 5; i++) {
      if (row[i] === '.') continue;
      g[7 + j][14 - (4 - i)] = row[i];
      g[7 + j][17 + (4 - i)] = row[i];
    }
  });
  rect(g, 15, 8, 2, 3, 'z');
  g[8][15] = 'a'; g[8][16] = 'a';
  return { top: g };
}

function hat() {
  const g = blank();
  tri(g, [[16, 0.4], [10.6, 9.0], [21.4, 9.0]], (x, y) => ((y === 5 || y === 8) ? 'A' : (x + y) % 5 === 0 ? 'z' : 'a'));
  rect(g, 9, 8, 14, 2, 'z');
  rect(g, 10, 8, 12, 1, 'a');
  g[0][16] = 'W'; g[0][15] = 'W'; g[1][15] = 'W'; g[1][16] = 'W';
  return { top: g };
}

function glasses() {
  const over = blank();
  for (const [cx, cy] of EYE_C) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > 3.3 && d < 4.4) over[y][x] = 'K';
      }
    }
  }
  return { over };
}

function flower() {
  const g = blank();
  const rows = ['.a.', 'aya', '.a.'];
  rows.forEach((row, j) => { for (let i = 0; i < 3; i++) if (row[i] !== '.') g[7 + j][21 + i] = row[i]; });
  g[10][21] = 'v';
  return { top: g };
}

// ---------- sprite frames ----------

const sprite = (rows, ox, oy) => {
  const px = [];
  rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.') px.push([ox + i, oy + j, row[i]]); });
  return px;
};

function eyePair(rows, lx, y) {
  const w = Math.max(...rows.map((r) => r.length));
  const a = sprite(rows, lx, y);
  const b = sprite(rows, N - lx - w, y); // same sprite, same shine side: not mirrored
  return a.concat(b);
}

function mouths(face) {
  const m = (rows, y, x = 14) => sprite(rows, x, y);
  if (face.beak) {
    const top = sprite(['yy', 'yY'], 15, 21);
    return {
      smile: top.concat(sprite(['Yy'], 15, 23)),
      small: top.concat(sprite(['Yy'], 15, 23), sprite(['YY'], 15, 24)),
      big: top.concat(sprite(['kk', 'tt', 'Yy'], 15, 23)),
      flat: top.concat(sprite(['YY'], 15, 23)),
      o: top.concat(sprite(['kk', 'kk', 'Yy'], 15, 23)),
      none: [],
    };
  }
  return {
    smile: m(['k..k', '.kk.'], 23),
    small: m(['.kk.', '.kk.'], 23),
    big: m(['kkkk', 'kttk', '.kk.'], 23),
    flat: m(['.kk.'], 23),
    o: m(['.kk.', 'kttk', '.kk.'], 23),
  };
}

function nose(face) {
  return face.beak ? [] : sprite(['kk', 'kk'], 15, 20);
}

// ---------- build ----------

function pathsOf(px, pal) {
  const by = new Map();
  for (const [x, y, k] of px) {
    if (!by.has(k)) by.set(k, new Map());
    const rows = by.get(k);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  let out = '';
  for (const [k, rows] of by) {
    let d = '';
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      let s = xs[0];
      let p = xs[0];
      for (let i = 1; i <= xs.length; i++) {
        if (i < xs.length && xs[i] === p + 1) { p = xs[i]; continue; }
        d += `M${s} ${y}h${p - s + 1}v1h${s - p - 1}z`;
        if (i < xs.length) { s = xs[i]; p = xs[i]; }
      }
    }
    out += `<path fill="${pal[k] || '#f0f'}" d="${d}"/>`;
  }
  return out;
}

const gridPx = (g) => {
  const px = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (g[y][x]) px.push([x, y, g[y][x]]);
  return px;
};

const grp = (cls, px, pal) => `<g class="px-f ${cls}">${pathsOf(px, pal)}</g>`;

function buildFrames(traits, pal, parts) {
  const { face } = parts;
  const LID = face.eyeDisc ? 'b' : null;
  const cover = (rows) => {
    // owl: lid colour painted over the white disc, from the top down
    if (!LID) return [];
    const px = [];
    for (const [cx, cy] of EYE_C) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= 3.9 && y < 14.5 + rows) px.push([x, y, LID]);
        }
      }
    }
    return px;
  };
  const CALM = ['.kkk.', 'kWWkk', 'kWWkk', 'kkkWk', '.kkk.'];
  const open = eyePair(CALM, EYE_X, EYE_Y);
  const mid = cover(3).concat(eyePair(['kkkkk', 'kkkWk', '.kkk.'], EYE_X, EYE_Y + 2));
  const closed = cover(6).concat(eyePair(['.kkk.'], EYE_X, EYE_Y + 3));
  const lineMid = cover(6).concat(eyePair(['kkkkk'], EYE_X, EYE_Y + 2));
  const up = eyePair(CALM, EYE_X + 1, EYE_Y); // a side glance, same height, so the face keeps its proportions
  const wide = eyePair(['.kkkk.', 'kWWkkk', 'kWWkkk', 'kkkkkk', 'kkkkWk', 'kkkikk', '.kkkk.'], EYE_X, EYE_Y - 2);
  const mo = mouths(face);
  const browsUp = sprite(['ooo'], 10, 12).concat(sprite(['ooo'], 19, 12));
  const browsThink = sprite(['ooo'], 10, 13).concat(sprite(['ooo'], 19, 12));
  const dots = [sprite(['ff', 'ff'], 28, 8), sprite(['ff', 'ff'], 29, 5), sprite(['ff', 'ff'], 28, 2)];
  const excl = sprite(['yy', 'yy', 'yy', 'yy', '..', 'yy'], 29, 1);
  const zs = [
    sprite(['fff', '..f', '.f.', 'fff'], 28, 7),
    sprite(['fff', '..f', '.f.', 'fff'], 28, 1),
  ];
  const paw = [];
  const blush = face.cheeks ? sprite(['rrr', 'rrr'], 6, 21).concat(sprite(['rrr', 'rrr'], 23, 21)) : [];
  const blushBig = face.cheeks ? sprite(['rrrr', 'rrrr'], 5, 21).concat(sprite(['rrrr', 'rrrr'], 23, 21)) : [];
  return (
    grp('px-e-open', open, pal) + grp('px-e-mid', mid, pal) + grp('px-e-closed', closed, pal) + grp('px-e-line', lineMid, pal) +
    grp('px-e-up', up, pal) + grp('px-e-wide', wide, pal) +
    grp('px-n', nose(face), pal) +
    grp('px-m-smile', mo.smile, pal) + grp('px-m-small', mo.small, pal) + grp('px-m-big', mo.big, pal) +
    grp('px-m-flat', mo.flat, pal) + grp('px-m-o', mo.o, pal) +
    grp('px-b-up', browsUp, pal) + grp('px-b-think', browsThink, pal) +
    grp('px-blush', blush, pal) + grp('px-blush-big', blushBig, pal) +
    grp('px-paw', paw, pal) +
    grp('px-dot px-dot-1', dots[0], pal) + grp('px-dot px-dot-2', dots[1], pal) + grp('px-dot px-dot-3', dots[2], pal) +
    grp('px-excl', excl, pal) + grp('px-z px-z-1', zs[0], pal) + grp('px-z px-z-2', zs[1], pal)
  );
}

const ACCESSORY = { bowtie, scarf, ribbon, hat, glasses, flower };
const accessoryOf = (name) => (ACCESSORY[name] ? ACCESSORY[name]() : null);

function buildArt(traits) {
  const pal = paletteOf(traits.color, traits.accessoryColor);
  const parts = partsOf(traits);
  const acc = accessoryOf(traits.accessory);

  const body = blank();
  stack([parts.body, parts.over], body);
  if (acc && acc.over) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (acc.over[y][x] && (!acc.clip || (body[y][x] && body[y][x] !== 'o'))) body[y][x] = acc.over[y][x];
      }
    }
  }
  if (acc && acc.top) stack([acc.top], body);

  const tail = blank();
  if (parts.tail) stack([parts.tail], tail);
  return {
    tail: parts.tail ? `<g class="px-tail">${pathsOf(gridPx(tail), pal)}</g>` : '',
    body: `<g class="px-body">${pathsOf(gridPx(body), pal)}</g>`,
    frames: buildFrames(traits, pal, parts),
  };
}

// ---------- style ----------

const CSS = `
.px-root{display:block;width:100%;height:100%;overflow:visible;shape-rendering:crispEdges;image-rendering:pixelated}
.px-root .px-f{visibility:hidden}
.px-all{transform:translate(0,0)}
.px-m-away .px-all{filter:brightness(.72) saturate(.6)}

.px-m-idle .px-n,.px-m-speaking .px-n,.px-m-thinking .px-n,.px-m-listening .px-n,.px-m-surprised .px-n,.px-m-away .px-n{visibility:visible}

/* idle: calm, slow blink, soft smile */
.px-m-idle .px-e-open{visibility:visible;animation:px-blink-open var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-idle .px-e-mid{animation:px-blink-mid var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-idle .px-e-closed{animation:px-blink-closed var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-idle .px-m-smile,.px-m-idle .px-blush{visibility:visible}
@keyframes px-blink-open{0%{visibility:visible}93%{visibility:hidden}100%{visibility:visible}}
@keyframes px-blink-mid{0%{visibility:hidden}93%{visibility:visible}95.5%{visibility:hidden}97.5%{visibility:visible}100%{visibility:hidden}}
@keyframes px-blink-closed{0%{visibility:hidden}95.5%{visibility:visible}97.5%{visibility:hidden}100%{visibility:hidden}}
.px-m-idle .px-all{animation:px-breathe 3.6s step-end infinite var(--px-tph,0s)}
.px-m-idle .px-tail{animation:px-sway 4.8s step-end infinite var(--px-tph,0s)}
@keyframes px-sway{0%{transform:translate(0,0)}35%{transform:translate(1px,0)}50%{transform:translate(1px,0)}70%{transform:translate(0,0)}100%{transform:translate(0,0)}}

/* speaking: mouth frames swap at about 6 Hz */
.px-m-speaking .px-e-open{visibility:visible;animation:px-blink-open var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-speaking .px-e-mid{animation:px-blink-mid var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-speaking .px-e-closed{animation:px-blink-closed var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-speaking .px-blush{visibility:visible}
.px-m-speaking .px-m-small{animation:px-ms-small 1.333s step-end infinite}
.px-m-speaking .px-m-big{animation:px-ms-big 1.333s step-end infinite}
.px-m-speaking .px-m-smile{animation:px-ms-smile 1.333s step-end infinite}
@keyframes px-ms-small{0%{visibility:visible}12.5%{visibility:hidden}25%{visibility:visible}37.5%{visibility:hidden}62.5%{visibility:visible}75%{visibility:hidden}100%{visibility:hidden}}
@keyframes px-ms-big{0%{visibility:hidden}12.5%{visibility:visible}25%{visibility:hidden}50%{visibility:visible}62.5%{visibility:hidden}87.5%{visibility:visible}100%{visibility:hidden}}
@keyframes px-ms-smile{0%{visibility:hidden}37.5%{visibility:visible}50%{visibility:hidden}75%{visibility:visible}87.5%{visibility:hidden}100%{visibility:hidden}}
.px-m-speaking .px-tail{animation:px-sway 1.6s step-end infinite var(--px-tph,0s)}

/* thinking: eyes up, one brow raised, paw at the chin, dots */
.px-m-thinking .px-e-up,.px-m-thinking .px-b-think,.px-m-thinking .px-paw,.px-m-thinking .px-m-flat{visibility:visible}
.px-m-thinking .px-dot-1{animation:px-d1 1.8s step-end infinite}
.px-m-thinking .px-dot-2{animation:px-d2 1.8s step-end infinite}
.px-m-thinking .px-dot-3{animation:px-d3 1.8s step-end infinite}
@keyframes px-d1{0%{visibility:hidden}16%{visibility:visible}100%{visibility:visible}}
@keyframes px-d2{0%{visibility:hidden}38%{visibility:visible}100%{visibility:visible}}
@keyframes px-d3{0%{visibility:hidden}60%{visibility:visible}92%{visibility:hidden}100%{visibility:hidden}}

/* listening: soft attentive face, gentle nods */
.px-m-listening .px-e-open{visibility:visible;animation:px-blink-open var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-listening .px-e-mid{animation:px-blink-mid var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-listening .px-e-closed{animation:px-blink-closed var(--px-blink,6s) step-end infinite var(--px-ph,0s)}
.px-m-listening .px-m-smile,.px-m-listening .px-blush-big{visibility:visible}
.px-m-listening .px-all{animation:px-nod 2.4s step-end infinite}
@keyframes px-nod{0%{transform:translate(0,0)}10%{transform:translate(0,1px)}22%{transform:translate(0,0)}34%{transform:translate(0,1px)}46%{transform:translate(0,0)}100%{transform:translate(0,0)}}

/* surprised: wide eyes, brows up, one small hop */
.px-m-surprised .px-excl,.px-m-surprised .px-e-wide,.px-m-surprised .px-b-up,.px-m-surprised .px-m-o{visibility:visible}
.px-m-surprised .px-all{animation:px-hop 1.2s step-end 1 both}
@keyframes px-hop{0%{transform:translate(0,0)}6%{transform:translate(0,-1px)}13%{transform:translate(0,-2px)}22%{transform:translate(0,-3px)}31%{transform:translate(0,-2px)}40%{transform:translate(0,-1px)}48%{transform:translate(0,0)}56%{transform:translate(0,-1px)}64%{transform:translate(0,0)}100%{transform:translate(0,0)}}

/* away: eyes closed, dimmed, z */
.px-m-away .px-e-closed,.px-m-away .px-m-flat{visibility:visible}
.px-m-away .px-z-1{animation:px-z1 3.2s step-end infinite}
.px-m-away .px-z-2{animation:px-z2 3.2s step-end infinite}
@keyframes px-z1{0%{visibility:hidden}20%{visibility:visible}100%{visibility:visible}}
@keyframes px-z2{0%{visibility:hidden}55%{visibility:visible}95%{visibility:hidden}100%{visibility:hidden}}
.px-m-away .px-all{animation:px-breathe 3.2s step-end infinite}
@keyframes px-breathe{0%{transform:translate(0,0)}50%{transform:translate(0,1px)}100%{transform:translate(0,0)}}
`;

function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const s = document.createElement('style');
  s.setAttribute('data-px', '');
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------- create ----------

export function create({ seed = '', look = {}, label } = {}) {
  void label;
  injectStyle();
  const traits = traitsOf({ seed, look });
  const art = buildArt(traits);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'px-root px-m-idle');
  svg.setAttribute('viewBox', `0 0 ${N} ${N}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.style.setProperty('--px-blink', `${traits.blinkEvery.toFixed(2)}s`);
  svg.style.setProperty('--px-ph', `${traits.blinkPhase.toFixed(2)}s`);
  svg.style.setProperty('--px-tph', `${traits.tailPhase.toFixed(2)}s`);

  svg.innerHTML = `<g class="px-all">${art.tail}${art.body}${art.frames}</g>`;

  let mood = 'idle';
  let ro = null;
  const fit = () => {
    const r = svg.getBoundingClientRect();
    const side = Math.min(r.width, r.height);
    if (!side) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const scale = Math.max(1 / dpr, Math.floor((side * dpr) / N + 0.3) / dpr); // whole device pixels per art pixel
    const units = side / scale;
    const off = -(units - N) / 2;
    svg.setAttribute('viewBox', `${off} ${off} ${units} ${units}`);
  };
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(fit);
    ro.observe(svg);
  }
  const api = {
    el: svg,
    get mood() { return mood; },
    setMood(m) {
      if (!MOODS.includes(m) || m === mood) return;
      svg.classList.remove('px-m-' + mood);
      svg.classList.add('px-m-' + m);
      mood = m;
    },
    destroy() { if (ro) ro.disconnect(); svg.remove(); },
  };
  return api;
}
