// Avatar taste "pixel": pixel-art plush animals on a 32 x 32 grid, drawn as SVG rects and animated by frame swapping.
//
// create({ seed, look, label }) -> { el, mood, setMood(mood), destroy() }
//   el      an <svg> that fills the square box its parent gives it; the viewBox is recomputed on resize so one art pixel
//           is always a whole number of device pixels (crisp edges, equal pixel sizes)
//   setMood swaps one class on the root; every frame stays in the DOM and CSS (prefix px-) toggles visibility in steps
//   look    optional overrides: { species, color, accessory, accessoryColor }
//           species fox | cat | bear | rabbit | owl, color '#rrggbb', accessory bowtie | ribbon | glasses | scarf | hat | none
// traitsOf({ seed, look }) returns the chosen traits without touching the DOM.

import { MOODS } from './mood.js';

export const id = 'pixel';
export const SPECIES = ['fox', 'cat', 'bear', 'rabbit', 'owl'];
export const ACCESSORIES = ['bowtie', 'ribbon', 'glasses', 'scarf', 'hat', 'none'];

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

export function traitsOf({ seed = '', look = {} } = {}) {
  const rnd = mulberry32(hash32('px|' + String(seed)));
  const r = Array.from({ length: 12 }, rnd); // fixed draw order: overriding one trait never shifts the others
  const l = look || {};
  const species = SPECIES.includes(l.species) ? l.species : SPECIES[Math.floor(r[0] * SPECIES.length)];
  const accessory = ACCESSORIES.includes(l.accessory) ? l.accessory : ACCESSORIES[Math.floor(r[1] * ACCESSORIES.length)];
  const color = toHsl(l.color) || { h: HUES[Math.floor(r[2] * HUES.length)] + (r[3] - 0.5) * 12, s: 56 + r[4] * 18, l: 74 + r[5] * 6 };
  return {
    key: String(seed),
    species,
    accessory,
    color,
    accessoryColor: toHsl(l.accessoryColor) || null,
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

// ---------- species ----------

const BCX = 16;
const BCY = 18.5;
const BRX = 10.4;
const BRY = 11.0;

function blob(g, footKey) {
  for (const cx of [11.6, 20.4]) ell(g, cx, 29.4, 3.1, 2.2, footKey || ((x, y, u, v) => lit(u, v, false)), { n: 2 });
  ell(g, BCX, BCY, BRX, BRY, (x, y, u, v) => lit(u, v), { n: 2.25 });
}

// Each species returns { tail: grid|null, body: grid } plus face hints.
function speciesParts(sp) {
  const tail = blank();
  const body = blank();
  let hasTail = true;
  const face = { eyeDisc: false, beak: false, cheeks: true };

  if (sp === 'fox') {
    // big tail rising on the right, pale tip with a chevron edge
    ell(tail, 26.3, 20.4, 5.3, 10.8, (x, y, u, v) => {
      const k = lit(u, v);
      if (v < -0.6) return k === 'd' || k === 'D' ? 'c' : 'w';
      return k;
    }, { rot: 12 });
    const ear = (m) => {
      const P = (x, y) => [m ? N - x : x, y];
      tri(body, [P(6.8, 1.6), P(4.8, 13.6), P(14.4, 9.6)], 'b');
      tri(body, [P(7.2, 5.4), P(6.6, 12.6), P(11.4, 10.4)], 'p');
    };
    ear(false); ear(true);
    blob(body);
    // pale muzzle
    ell(body, 16, 21.8, 4.9, 3.1, (x, y) => (y > 23 ? 'c' : 'w'), { n: 2.4 });
  } else if (sp === 'cat') {
    // thin curled tail
    const pts = [[25, 28], [28, 27], [29.5, 24], [29.5, 20.5], [28.5, 17.5], [29.5, 15]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      for (let t = 0; t <= 1; t += 0.05) {
        const px = x0 + (x1 - x0) * t;
        const py = y0 + (y1 - y0) * t;
        ell(tail, px, py, 1.9, 1.9, (x, y, u, v) => lit(u, v, false), { n: 2 });
      }
    }
    const ear = (m) => {
      const P = (x, y) => [m ? N - x : x, y];
      tri(body, [P(6.8, 2.0), P(5.0, 13.0), P(13.2, 9.6)], 'b');
      tri(body, [P(7.4, 5.8), P(6.6, 12.4), P(11.0, 10.4)], 'p');
    };
    ear(false); ear(true);
    blob(body);
    // whiskers
    for (const [x, y] of [[2, 18], [3, 19], [4, 19], [2, 22], [3, 21], [4, 21]]) { body[y][x] = 'W'; body[y][N - 1 - x] = 'W'; }
    // forehead stripes
    for (const [x, y0, y1] of [[15, 9, 11], [16, 9, 11], [12, 10, 11], [19, 10, 11]]) for (let y = y0; y <= y1; y++) body[y][x] = 'd';
    // pale chin
    ell(body, 16, 22.4, 4.2, 2.4, 'w', { n: 2.4 });
  } else if (sp === 'bear') {
    hasTail = false;
    const ear = (m) => {
      const cx = m ? N - 7.4 : 7.4;
      ell(body, cx, 9.4, 3.5, 3.4, (x, y, u, v) => lit(u, v, false), { n: 2 });
      ell(body, m ? N - 7.6 : 7.6, 9.8, 1.7, 1.6, 'p', { n: 2 });
    };
    ear(false); ear(true);
    blob(body);
    ell(body, 16, 21.4, 5.6, 4.4, (x, y, u, v) => (v > 0.45 ? 'c' : 'w'), { n: 2.2 });
  } else if (sp === 'rabbit') {
    // cotton tail low on the right
    ell(tail, 27.8, 26.6, 3.6, 3.6, (x, y, u, v) => (lit(u, v, false) === 'b' || lit(u, v, false) === 'h' ? 'w' : 'c'), { n: 2 });
    const ear = (m) => {
      const cx = m ? N - 10.4 : 10.4;
      const rot = m ? 10 : -10;
      ell(body, cx, 5.4, 2.8, 8.0, (x, y, u, v) => lit(u, v, false), { rot, n: 2 });
      ell(body, cx + (m ? -0.2 : 0.2), 6.0, 1.3, 5.6, 'p', { rot, n: 2 });
    };
    ear(false); ear(true);
    blob(body);
    ell(body, 16, 21.6, 5.4, 3.4, (x, y, u, v) => (v > 0.4 ? 'c' : 'w'), { n: 2.3 });
  } else {
    // owl: ear tufts, wing sides, round belly, big eye discs
    hasTail = false;
    face.eyeDisc = true;
    face.beak = true;
    face.cheeks = false;
    const tuft = (m) => {
      const P = (x, y) => [m ? N - x : x, y];
      tri(body, [P(6.2, 3.4), P(5.4, 12.0), P(12.6, 9.6)], 'd');
    };
    tuft(false); tuft(true);
    blob(body, 'y');
    const wing = (m) => {
      const cx = m ? N - 5.6 : 5.6;
      ell(body, cx, 22.4, 2.4, 6.0, (x, y, u, v) => 'd', { rot: m ? -8 : 8, n: 2 });
    };
    wing(false); wing(true);
    ell(body, 16, 26.0, 6.4, 4.6, (x, y, u, v) => (((x + y) & 1) === 0 && v < 0.1 ? 'c' : 'w'), { n: 2.3 });
    ell(body, 11.0, 16.4, 3.9, 3.9, 'w', { n: 2 });
    ell(body, 21.0, 16.4, 3.9, 3.9, 'w', { n: 2 });
  }
  return { tail: hasTail ? tail : null, body, face };
}

// ---------- accessories ----------

function bowtie() {
  const g = blank();
  const rows = ['kk....', 'kgkk.k', 'kkkkKk', 'kkkk.k', 'kk....'];
  rows.forEach((row, j) => {
    for (let i = 0; i < 6; i++) {
      const ch = row[i];
      if (ch === '.') continue;
      g[24 + j][10 + i] = ch;
      g[24 + j][N - 1 - (10 + i)] = ch === 'g' ? 'k' : ch;
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
  for (const cx of [11.0, 21.0]) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - 16.5);
        if (d > 3.1 && d < 4.3) over[y][x] = 'K';
      }
    }
  }
  rect(over, 14, 16, 4, 1, 'K');
  return { over };
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

const EYE_Y = 15;
const EYE_X = 10;

function mouths(face) {
  const m = (rows, y, x = 14) => sprite(rows, x, y);
  if (face.beak) {
    const top = sprite(['yy', 'yY'], 15, 19);
    return {
      smile: top.concat(sprite(['Yy'], 15, 21)),
      small: top.concat(sprite(['Yy'], 15, 21), sprite(['YY'], 15, 22)),
      big: top.concat(sprite(['kk', 'tt', 'Yy'], 15, 21)),
      flat: top.concat(sprite(['YY'], 15, 21)),
      o: top.concat(sprite(['kk', 'kk', 'Yy'], 15, 21)),
      none: [],
    };
  }
  return {
    smile: m(['k..k', '.kk.'], 22),
    small: m(['.kk.', '.kk.'], 22),
    big: m(['kkkk', 'ktty', '.kk.'], 22).map(([x, y, k]) => [x, y, k === 'y' ? 't' : k]),
    flat: m(['.kk.'], 23),
    o: m(['.kk.', 'k..k', '.kk.'], 22),
  };
}

function nose(face) {
  return face.beak ? [] : sprite(['kk', 'kk'], 15, 19);
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
  const eyeY = EYE_Y;
  const cover = (rows) => {
    // owl: lid colour painted over the white disc, from the top down
    if (!LID) return [];
    const px = [];
    for (const cx of [11.0, 21.0]) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - 16.4);
          if (d <= 3.9 && y < 12.5 + rows) px.push([x, y, LID]);
        }
      }
    }
    return px;
  };
  const open = eyePair(['Wk', 'kk', 'kk'], EYE_X, eyeY);
  const mid = cover(3).concat(eyePair(['kk', 'kk'], EYE_X, eyeY + 1));
  const closed = cover(7).concat(eyePair(['kk'], EYE_X, eyeY + 2));
  const lineMid = cover(7).concat(eyePair(['kk'], EYE_X, eyeY + 1));
  const up = eyePair(['Wk', 'kk', 'kk'], EYE_X + 1, eyeY - 1);
  const wide = eyePair(['Wkk', 'kkk', 'kkk', 'kkk'], EYE_X - 1, eyeY - 1);
  const mo = mouths(face);
  const browsUp = sprite(['ooo'], 9, 11).concat(sprite(['ooo'], 20, 11));
  const browsThink = sprite(['ooo'], 9, 12).concat(sprite(['ooo'], 20, 11));
  const dots = [sprite(['ff', 'ff'], 28, 8), sprite(['ff', 'ff'], 29, 5), sprite(['ff', 'ff'], 28, 2)];
  const excl = sprite(['yy', 'yy', 'yy', 'yy', '..', 'yy'], 29, 1);
  const zs = [
    sprite(['fff', '..f', '.f.', 'fff'], 28, 7),
    sprite(['fff', '..f', '.f.', 'fff'], 28, 1),
  ];
  const pawG = blank();
  const pawKey = (x, y, u, v) => { const k = lit(u, v, false); return k === 'b' ? 'h' : k; };
  ell(pawG, 23.2, 27.4, 2.6, 4.0, pawKey, { rot: -38, n: 2 });
  ell(pawG, 19.8, 23.6, 3.0, 2.6, pawKey, { n: 2 });
  const paw = gridPx(stack([pawG]));
  const blush = face.cheeks ? sprite(['rr'], 7, 19).concat(sprite(['rr'], 23, 19)) : [];
  const blushBig = face.cheeks ? sprite(['rrr'], 6, 19).concat(sprite(['rrr'], 23, 19)) : [];
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

const accessoryOf = (name) => (name === 'bowtie' ? bowtie() : name === 'scarf' ? scarf() : name === 'ribbon' ? ribbon() : name === 'hat' ? hat() : name === 'glasses' ? glasses() : null);

function buildArt(traits) {
  const pal = paletteOf(traits.color, traits.accessoryColor);
  const parts = speciesParts(traits.species);
  const acc = accessoryOf(traits.accessory);

  const body = blank();
  stack([parts.body], body);
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
.px-m-thinking .px-all{animation:px-think 3.6s step-end infinite}
@keyframes px-think{0%{transform:translate(0,0)}50%{transform:translate(0,1px)}75%{transform:translate(0,0)}}

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
