// Avatar taste "critters": round, fluffy animals whose faces are built to be read at a glance.
//
// create({ seed, look, label }) -> { el, mood, setMood(mood), destroy() }
//   el        an <svg> (viewBox 0 0 240 240) that fills the square box its parent gives it
//   setMood   swaps one class on the root; every part stays in the DOM and CSS (prefix cr-) does the rest
//   look      optional overrides: { species, color, accessory, accessoryColor, tail }
//             species fox | cat | bear | rabbit | owl, color '#rrggbb', accessory bowtie | ribbon | glasses | scarf | hat | none,
//             tail 'left' | 'right'. Everything else (ear tilt, blush, eye spacing, tempo) comes from a stable hash of `seed`.
// traitsOf({ seed, look }) returns the chosen traits without touching the DOM.

import { MOODS } from './mood.js';

export const id = 'critters';
export const SPECIES = ['fox', 'cat', 'bear', 'rabbit', 'owl'];
export const ACCESSORIES = ['bowtie', 'ribbon', 'glasses', 'scarf', 'hat', 'none'];

// Layout of the 240 x 240 canvas: round body in the middle, face on its lower half, FX band along the top.
const CX = 120;
const CY = 146;
const RX = 82;
const RY = 72;
const EY = 142; // eye line
const BY = 106; // brow line
const NY = 162; // nose centre
const MT = 171; // top of the mouth
const INK = '#2b2024';
const PUPIL = '#1c1517';
const HUES = [350, 12, 28, 44, 140, 168, 190, 208, 230, 262, 290, 322];

let serial = 0;

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

const f1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hsl = (h, s, l, a) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 4, 97))}%${a === undefined ? '' : ' / ' + a})`;

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

export function traitsOf({ seed = '', look = {} } = {}) {
  const rnd = mulberry32(hash32('cr|' + String(seed)));
  const r = Array.from({ length: 20 }, rnd); // fixed draw order: overriding one trait never shifts the others
  const l = look || {};
  const species = SPECIES.includes(l.species) ? l.species : SPECIES[Math.floor(r[0] * SPECIES.length)];
  const accessory = ACCESSORIES.includes(l.accessory) ? l.accessory : ACCESSORIES[Math.floor(r[1] * ACCESSORIES.length)];
  const color = toHsl(l.color) || { h: HUES[Math.floor(r[2] * HUES.length)] + (r[3] - 0.5) * 12, s: 62 + r[4] * 16, l: 78 + r[5] * 6 };
  return {
    key: String(seed),
    species,
    accessory,
    color,
    accessoryColor: toHsl(l.accessoryColor) || null,
    tilt: [(r[6] - 0.5) * 12, (r[7] - 0.5) * 12],
    blush: 0.85 + r[8] * 0.45,
    eyeDx: 30 + r[9] * 3,
    tail: l.tail === 'left' ? -1 : l.tail === 'right' ? 1 : species === 'fox' ? 1 : r[10] < 0.5 ? 1 : -1,
    accent: color.h + 150 + r[11] * 60,
    tempo: 0.95 + r[12] * 0.13,
    phase: -(r[13] * 40),
    hatTilt: (r[14] - 0.5) * 18,
  };
}

function paletteOf({ h, s, l }) {
  return {
    base: hsl(h, s, l),
    hi: hsl(h, s - 6, l + 7),
    pale: hsl(h, s - 14, l + 14),
    inner: hsl(h - 8, s + 6, l + 8),
    lo: hsl(h, s - 2, l - 8),
    deep: hsl(h, s + 6, l - 22),
    line: hsl(h, s + 8, l - 36, 0.5),
    blush: hsl(h - 14, 92, 66),
  };
}

// ---------- fur ----------

function fluffPath(cx, cy, rx, ry, n, bulge, rnd) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const j = 1 + (rnd() - 0.5) * 0.018;
    pts.push([cx + Math.cos(a) * rx * j, cy + Math.sin(a) * ry * j]);
  }
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + 1) % n];
    const am = ((i + 0.5) / n) * Math.PI * 2;
    d += `Q${f1(cx + Math.cos(am) * rx * (1 + bulge))} ${f1(cy + Math.sin(am) * ry * (1 + bulge))} ${f1(p[0])} ${f1(p[1])}`;
  }
  return d + 'Z';
}

const furSvg = (f, c) => `<path d="${f.dark}" fill="none" stroke="${c.lo}" stroke-opacity=".34" stroke-width="1.7" stroke-linecap="round"/>` +
  `<path d="${f.light}" fill="none" stroke="${c.pale}" stroke-opacity=".6" stroke-width="1.7" stroke-linecap="round"/>`;

function furStrokes(rnd, n, cx, cy, rx, ry, minLen, maxLen, bounded = true) {
  let light = '';
  let dark = '';
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 0.95;
    const x = cx + Math.cos(a) * rx * r;
    const y = cy + Math.sin(a) * ry * r;
    let dx = x - CX;
    let dy = y - (CY + 8);
    const m = Math.hypot(dx, dy) || 1;
    dx /= m; dy /= m;
    const len = minLen + rnd() * (maxLen - minLen);
    const bend = (rnd() - 0.5) * len * 0.7;
    const ex = x + dx * len;
    const ey = y + dy * len;
    const keep = rnd();
    if (bounded && ((ex - cx) / rx) ** 2 + ((ey - cy) / ry) ** 2 > 0.93) continue;
    const seg = `M${f1(x)} ${f1(y)}Q${f1(x + dx * len * 0.5 - dy * bend)} ${f1(y + dy * len * 0.5 + dx * bend)} ${f1(ex)} ${f1(ey)}`;
    if (keep < 0.5) light += seg; else dark += seg;
  }
  return { light, dark };
}

// ---------- parts that differ per species ----------

const both = (fn) => fn(-1, 'cr-l') + fn(1, 'cr-r');
const X = (sx, d) => f1(CX + sx * d);

// An ear is wrapped twice: the outer group holds the fixed per-avatar tilt, the inner one is what CSS animates.
function earWrap(sx, cls, tilt, pivotDx, pivotY, inner) {
  const px = X(sx, pivotDx);
  return `<g transform="rotate(${f1(sx * tilt)} ${px} ${pivotY})"><g class="cr-ear ${cls} cr-ear-${sx < 0 ? 'l' : 'r'}" style="transform-origin:${px}px ${pivotY}px">${inner}</g></g>`;
}

const roundedTri = (pts, fill, w) => `<path d="M${pts.join('L')}Z" fill="${fill}" stroke="${fill}" stroke-width="${w}" stroke-linejoin="round"/>`;

const SHAPES = {
  fox: {
    shift: 9,
    eye: { rx: 18.5, ry: 21, pr: 12.5 },
    ears: (c, t) => both((sx, cls) => earWrap(sx, cls, t.tilt[sx < 0 ? 0 : 1], 50, 104,
      roundedTri([`${X(sx, 70)} 116`, `${X(sx, 60)} 60`, `${X(sx, 27)} 86`], c.fur, 14) +
      roundedTri([`${X(sx, 63)} 111`, `${X(sx, 59)} 72`, `${X(sx, 38)} 90`], c.pale, 8))),
    tail: (c, rnd, uid) => {
      const d = fluffPath(203, 152, 26, 62, 40, 0.045, rnd);
      const spin = 'rotate(12 203 152)';
      return {
        pivot: [180, 200],
        clip: d,
        clipTransform: spin,
        furBox: [204, 152, 25, 58],
        defs: `<clipPath id="${uid}-tp"><rect x="170" y="80" width="70" height="38"/></clipPath>`,
        svg: `<g transform="${spin}"><path d="${d}" fill="${c.fur}"/><path d="${d}" fill="${c.pale}" clip-path="url(#${uid}-tp)"/></g>`,
      };
    },
    marks: (c) => `<ellipse cx="120" cy="173" rx="31" ry="24" fill="${c.pale}"/>`,
    nose: () => noseShape(INK, 1),
    mouth: () => mouths(),
  },
  cat: {
    shift: 6,
    eye: { rx: 18.5, ry: 21, pr: 12.5 },
    ears: (c, t) => both((sx, cls) => earWrap(sx, cls, t.tilt[sx < 0 ? 0 : 1], 48, 104,
      roundedTri([`${X(sx, 71)} 120`, `${X(sx, 57)} 58`, `${X(sx, 24)} 88`], c.fur, 14) +
      roundedTri([`${X(sx, 63)} 114`, `${X(sx, 57)} 74`, `${X(sx, 37)} 92`], c.inner, 8))),
    tail: (c) => ({
      pivot: [172, 204],
      svg: `<path d="M166 205C204 216 234 180 221 144C215 126 226 112 230 98" fill="none" stroke="${c.fur}" stroke-width="19" stroke-linecap="round"/>` +
        `<path d="M166 205C204 216 234 180 221 144C215 126 226 112 230 98" fill="none" stroke="${c.lo}" stroke-width="19" stroke-dasharray="7 21" stroke-dashoffset="-6"/>`,
    }),
    marks: (c) => `<ellipse cx="120" cy="174" rx="25" ry="19" fill="${c.pale}"/>` +
      `<path d="M120 84L120 98M104 87L107 99M136 87L133 99" stroke="${c.deep}" stroke-opacity=".55" stroke-width="4.5" stroke-linecap="round" fill="none"/>`,
    nose: (c) => noseShape(c.nosePink, 0.92),
    mouth: () => mouths(),
    whiskers: (c) => both((sx) => `<path d="M${X(sx, 36)} 168L${X(sx, 66)} 163M${X(sx, 36)} 175L${X(sx, 68)} 175M${X(sx, 38)} 182L${X(sx, 64)} 187" stroke="${c.deep}" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round" fill="none"/>`),
  },
  bear: {
    shift: 0,
    eye: { rx: 17.5, ry: 20, pr: 12 },
    ears: (c, t) => both((sx, cls) => earWrap(sx, cls, t.tilt[sx < 0 ? 0 : 1], 58, 100,
      `<circle cx="${X(sx, 60)}" cy="94" r="24" fill="${c.fur}"/><circle cx="${X(sx, 60)}" cy="96" r="12.5" fill="${c.pale}"/>`)),
    tail: (c) => ({
      pivot: [176, 196],
      svg: `<circle cx="178" cy="198" r="15" fill="${c.fur}"/><circle cx="182" cy="200" r="8" fill="${c.pale}" opacity=".7"/>`,
    }),
    marks: (c) => `<ellipse cx="120" cy="175" rx="33" ry="26" fill="${c.pale}"/>`,
    nose: () => noseShape(INK, 1.25),
    mouth: () => mouths(),
  },
  rabbit: {
    shift: 0,
    eye: { rx: 17.5, ry: 21, pr: 12.5 },
    ears: (c, t) => both((sx, cls) => earWrap(sx, cls, 9 + t.tilt[sx < 0 ? 0 : 1], 32, 108,
      `<ellipse cx="${X(sx, 33)}" cy="70" rx="17" ry="40" fill="${c.fur}"/><ellipse cx="${X(sx, 33)}" cy="74" rx="8.5" ry="28" fill="${c.inner}"/>`)),
    tail: (c, rnd) => ({
      pivot: [180, 198],
      svg: `<path d="${fluffPath(182, 200, 17, 17, 14, 0.14, rnd)}" fill="${c.pale}"/>`,
    }),
    marks: (c) => `<ellipse cx="120" cy="174" rx="30" ry="23" fill="${c.pale}"/>` +
      both((sx) => `<circle cx="${X(sx, 20)}" cy="180" r="16" fill="${c.pale}"/>`),
    nose: (c) => noseShape(c.nosePink, 0.85),
    mouth: () => mouths(),
  },
  owl: {
    shift: 0,
    eye: { rx: 21, ry: 22.5, pr: 13.5 },
    ears: (c, t) => both((sx, cls) => earWrap(sx, cls, t.tilt[sx < 0 ? 0 : 1], 52, 100,
      roundedTri([`${X(sx, 72)} 110`, `${X(sx, 66)} 70`, `${X(sx, 36)} 88`], c.lo, 11))),
    tail: (c) => ({
      pivot: [120, 216],
      svg: `<ellipse cx="102" cy="224" rx="10" ry="15" fill="${c.lo}" transform="rotate(14 102 224)"/><ellipse cx="138" cy="224" rx="10" ry="15" fill="${c.lo}" transform="rotate(-14 138 224)"/><ellipse cx="120" cy="227" rx="10" ry="15" fill="${c.deep}"/>`,
    }),
    marks: (c) => both((sx) => `<circle cx="${X(sx, 31)}" cy="${EY - 3}" r="36" fill="${c.pale}"/>`) +
      `<path d="M120 112L108 134L132 134Z" fill="${c.pale}"/>` +
      `<path d="M92 192q6 8 12 0M108 198q6 8 12 0M124 198q6 8 12 0M140 192q6 8 12 0M100 208q6 7 11 0M116 212q6 7 12 0M133 208q6 7 11 0" fill="none" stroke="${c.deep}" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>`,
    nose: () => `<path d="M${CX - 9.5} ${NY - 9}Q${CX} ${NY - 14} ${CX + 9.5} ${NY - 9}L${CX} ${NY + 4}Z" fill="#f4a734" stroke="#f4a734" stroke-width="3" stroke-linejoin="round"/>`,
    mouth: () => beakMouths(),
  },
};

function noseShape(fill, k) {
  const w = 8.5 * k;
  return `<path d="M${f1(CX - w)} ${f1(NY - 7 * k)}Q${CX} ${f1(NY - 11 * k)} ${f1(CX + w)} ${f1(NY - 7 * k)}Q${f1(CX + w * 0.82)} ${f1(NY + 0.5 * k)} ${CX} ${f1(NY + 3.5 * k)}Q${f1(CX - w * 0.82)} ${f1(NY + 0.5 * k)} ${f1(CX - w)} ${f1(NY - 7 * k)}Z" fill="${fill}" stroke="${fill}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<ellipse cx="${f1(CX - 2.8 * k)}" cy="${f1(NY - 6.4 * k)}" rx="${f1(3 * k)}" ry="${f1(1.5 * k)}" fill="#fff" opacity=".55"/>`;
}

// One shape per mood; CSS shows exactly one of them.
function mouths() {
  const tongue = `<ellipse cx="${CX}" cy="${MT + 17}" rx="9" ry="5.5" fill="#ef7f90"/>`;
  const smile = `M${CX} ${NY + 3.5}L${CX} ${MT + 1}M${CX} ${MT + 1}Q${CX - 7} ${MT + 11} ${CX - 15} ${MT + 3}M${CX} ${MT + 1}Q${CX + 7} ${MT + 11} ${CX + 15} ${MT + 3}`;
  const stroke = `fill="none" stroke="${INK}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"`;
  return `<path class="cr-mo-smile" d="${smile}" ${stroke}/>` +
    `<g class="cr-mo-open"><path d="M${CX - 15} ${MT}Q${CX} ${MT - 2} ${CX + 15} ${MT}Q${CX + 14} ${MT + 24} ${CX} ${MT + 24}Q${CX - 14} ${MT + 24} ${CX - 15} ${MT}Z" fill="#3a1b24"/>${tongue}</g>` +
    `<g class="cr-mo-o"><ellipse cx="${CX}" cy="${MT + 4}" rx="10" ry="13.5" fill="#3a1b24"/><ellipse cx="${CX}" cy="${MT + 11}" rx="6" ry="4.5" fill="#ef7f90"/></g>` +
    `<path class="cr-mo-hmm" d="M${CX - 14} ${MT + 3}Q${CX - 7} ${MT - 3} ${CX} ${MT + 3}T${CX + 14} ${MT + 1}" ${stroke}/>` +
    `<ellipse class="cr-mo-zz" cx="${CX}" cy="${MT + 3}" rx="5" ry="4.2" fill="${INK}" opacity=".85"/>`;
}

function beakMouths() {
  const lower = `M${CX - 6} ${NY + 1}L${CX + 6} ${NY + 1}L${CX} ${NY + 9}Z`;
  const closed = `fill="#e8901f" stroke="#e8901f" stroke-width="2" stroke-linejoin="round"`;
  return `<path class="cr-mo-smile" d="${lower}" ${closed}/>` +
    `<g class="cr-mo-open"><path d="M${CX - 12} ${NY + 2}Q${CX} ${NY} ${CX + 12} ${NY + 2}Q${CX + 11} ${NY + 22} ${CX} ${NY + 22}Q${CX - 11} ${NY + 22} ${CX - 12} ${NY + 2}Z" fill="#3a1b24"/><ellipse cx="${CX}" cy="${NY + 15}" rx="7" ry="4.5" fill="#ef7f90"/></g>` +
    `<g class="cr-mo-o"><ellipse cx="${CX}" cy="${NY + 8}" rx="8.5" ry="11.5" fill="#3a1b24"/><ellipse cx="${CX}" cy="${NY + 14}" rx="5" ry="3.8" fill="#ef7f90"/></g>` +
    `<path class="cr-mo-hmm" d="${lower}" ${closed}/>` +
    `<path class="cr-mo-zz" d="${lower}" ${closed}/>`;
}

// ---------- shared parts ----------

function eyeMarkup(cls, x, c, e) {
  const { rx, ry, pr } = e;
  return `<g class="cr-eye ${cls}">` +
    `<ellipse cx="${f1(x)}" cy="${EY}" rx="${rx}" ry="${ry}" fill="#fffdf9" stroke="${c.line}" stroke-width="1.5"/>` +
    `<g class="cr-pupil"><circle cx="${f1(x)}" cy="${EY}" r="${pr}" fill="${PUPIL}"/>` +
    `<circle cx="${f1(x - pr * 0.38)}" cy="${f1(EY - pr * 0.45)}" r="${f1(pr * 0.42)}" fill="#fff"/>` +
    `<circle cx="${f1(x + pr * 0.4)}" cy="${f1(EY + pr * 0.46)}" r="${f1(pr * 0.19)}" fill="#fff" opacity=".92"/></g></g>`;
}

function browMarkup(cls, x) {
  const [a, b] = cls === 'cr-l' ? [5, 3] : [3, 5]; // the outer end sits lower
  return `<path class="cr-brow ${cls}" d="M${f1(x - 17)} ${BY + a}Q${f1(x)} ${BY - 7} ${f1(x + 17)} ${BY + b}" fill="none" stroke="${INK}" stroke-width="5.6" stroke-linecap="round"/>`;
}

function closedEyes(x1, x2, e) {
  const w = e.rx * 0.78;
  const p = (x) => `M${f1(x - w)} ${EY}Q${f1(x)} ${EY + 13} ${f1(x + w)} ${EY}`;
  return `<path class="cr-eyes-closed" d="${p(x1)}${p(x2)}" fill="none" stroke="${INK}" stroke-width="4.6" stroke-linecap="round"/>`;
}

function pawMarkup(sx, c, owl) {
  const side = sx < 0 ? 'l' : 'r';
  const x = CX + sx * 44;
  const y = 205;
  const shape = owl
    ? `<ellipse cx="${x}" cy="${y}" rx="12" ry="15" fill="${c.lo}" stroke="${c.line}" stroke-width="1.6"/>`
    : `<ellipse cx="${x}" cy="${y}" rx="15" ry="13" fill="${c.hi}" stroke="${c.line}" stroke-width="1.6"/>` +
      `<path d="M${x - 5.5} ${y - 9}L${x - 5} ${y - 3}M${x + 5.5} ${y - 9}L${x + 5} ${y - 3}" stroke="${c.line}" stroke-width="1.8" stroke-linecap="round" fill="none"/>`;
  return `<g class="cr-paw cr-paw-${side} cr-${side}">${shape}</g>`;
}

function accessoryMarkup(t) {
  const ac = t.accessoryColor || { h: t.accent, s: 70, l: 58 };
  const col = hsl(ac.h, ac.s, ac.l);
  const colHi = hsl(ac.h, ac.s - 8, ac.l + 14);
  const colLo = hsl(ac.h, ac.s + 6, ac.l - 16);
  switch (t.accessory) {
    case 'bowtie': {
      const body = t.accessoryColor ? col : '#26232a';
      const hi = t.accessoryColor ? colHi : '#5a5660';
      const lo = t.accessoryColor ? colLo : '#121014';
      return `<g class="cr-acc"><path d="M120 204L96 191Q90 204 96 217Z" fill="${body}" stroke="${body}" stroke-width="3" stroke-linejoin="round"/>` +
        `<path d="M120 204L144 191Q150 204 144 217Z" fill="${body}" stroke="${body}" stroke-width="3" stroke-linejoin="round"/>` +
        `<path d="M101 196L113 202M101 211L113 206M139 196L127 202M139 211L127 206" stroke="${lo}" stroke-width="2" stroke-linecap="round" opacity=".7"/>` +
        `<path d="M98 194Q95 204 98 213" stroke="${hi}" stroke-width="1.8" stroke-linecap="round" fill="none" opacity=".8"/>` +
        `<rect x="113" y="196" width="14" height="16" rx="5" fill="${body}" stroke="${hi}" stroke-width="1.2"/></g>`;
    }
    case 'ribbon': {
      const bx = CX + 38 * (t.tail > 0 ? -1 : 1);
      const by = 90;
      return `<g class="cr-acc" transform="translate(${bx} ${by}) rotate(${f1(t.hatTilt)})">` +
        `<path d="M0 0L-10 22L-2 19L0 26Z" fill="${colLo}"/><path d="M0 0L11 21L3 19L0 26Z" fill="${colLo}"/>` +
        `<path d="M0 0C-8-14-26-14-26 0C-26 12-8 10 0 0Z" fill="${col}" stroke="${colLo}" stroke-width="1.6"/>` +
        `<path d="M0 0C8-14 26-14 26 0C26 12 8 10 0 0Z" fill="${col}" stroke="${colLo}" stroke-width="1.6"/>` +
        `<path d="M-6-5Q-14-8-20-4M6-5Q14-8 20-4" stroke="${colHi}" stroke-width="2.2" stroke-linecap="round" fill="none"/>` +
        `<circle r="6" fill="${colHi}" stroke="${colLo}" stroke-width="1.6"/></g>`;
    }
    case 'glasses': {
      const r = SHAPES[t.species].eye.rx + 9;
      const frame = '#2a2b35';
      const lens = (x) => `<circle cx="${f1(x)}" cy="${EY}" r="${r}" fill="#cfe3ff" fill-opacity=".16" stroke="${frame}" stroke-width="4.2"/>` +
        `<path d="M${f1(x - r * 0.62)} ${f1(EY - r * 0.28)}Q${f1(x - r * 0.45)} ${f1(EY - r * 0.62)} ${f1(x - r * 0.1)} ${f1(EY - r * 0.72)}" stroke="#fff" stroke-opacity=".75" stroke-width="3" stroke-linecap="round" fill="none"/>`;
      const x1 = CX - t.eyeDx;
      const x2 = CX + t.eyeDx;
      return `<g class="cr-acc">${lens(x1)}${lens(x2)}<path d="M${f1(x1 + r)} ${EY - 2}Q${CX} ${EY - 10} ${f1(x2 - r)} ${EY - 2}" stroke="${frame}" stroke-width="4" fill="none" stroke-linecap="round"/>` +
        `<path d="M${f1(x1 - r)} ${EY - 4}L${f1(x1 - r - 12)} ${EY - 9}M${f1(x2 + r)} ${EY - 4}L${f1(x2 + r + 12)} ${EY - 9}" stroke="${frame}" stroke-width="3.6" stroke-linecap="round"/></g>`;
    }
    case 'scarf':
      return `<g class="cr-acc"><path d="M68 192Q120 214 172 192L174 207Q120 229 66 207Z" fill="${col}" stroke="${colLo}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M70 198Q120 220 170 198M68 203Q120 225 168 203" stroke="${colHi}" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".85"/>` +
        `<path d="M146 210L168 206L173 232L151 235Z" fill="${col}" stroke="${colLo}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M149 219L170 215M150 226L172 222" stroke="${colHi}" stroke-width="2.6" stroke-linecap="round" opacity=".85"/></g>`;
    case 'hat':
      return `<g class="cr-acc" transform="rotate(${f1(t.hatTilt * 0.8)} 120 82)">` +
        `<ellipse cx="120" cy="80" rx="28" ry="7" fill="#2a2830"/>` +
        `<path d="M103 80L105 48Q120 42 135 48L137 80Z" fill="#34323c"/>` +
        `<ellipse cx="120" cy="48" rx="15" ry="4" fill="#44424e"/>` +
        `<path d="M103.5 72L136.5 72L137 80L103 80Z" fill="${col}"/>` +
        `<path d="M107 52L108 70" stroke="#fff" stroke-opacity=".18" stroke-width="3" stroke-linecap="round"/></g>`;
    default:
      return '';
  }
}

// FX glyphs sit in the top-right band of the box, above the ears; each shows in one mood only.
function fxMarkup() {
  const z = (cls, x, y, k) => `<g transform="translate(${x} ${y}) scale(${k})"><path class="cr-z ${cls}" d="M0 0L14 0L0 16L14 16" fill="none" stroke="#e8eaed" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  return `<g class="cr-fx">` +
    `<g class="cr-fx-dots"><rect x="172" y="4" width="64" height="32" rx="16" fill="#ffffff" fill-opacity=".22"/><path d="M182 34L177 46L192 35Z" fill="#ffffff" fill-opacity=".22"/>` +
    `<circle cx="190" cy="20" r="5.6" fill="#f1f3f4"/><circle cx="204" cy="20" r="5.6" fill="#f1f3f4"/><circle cx="218" cy="20" r="5.6" fill="#f1f3f4"/></g>` +
    `<g class="cr-fx-bang"><rect x="203" y="6" width="12" height="27" rx="6" fill="#ffc933"/><circle cx="209" cy="44" r="6.4" fill="#ffc933"/></g>` +
    `<g class="cr-fx-zzz">${z('cr-z1', 176, 70, 0.7)}${z('cr-z2', 190, 46, 0.9)}${z('cr-z3', 206, 20, 1.15)}</g>` +
    `</g>`;
}

function build(traits, uid, label) {
  const t = traits;
  const sp = SHAPES[t.species];
  const rnd = mulberry32(hash32('fur|' + t.key));
  const base = paletteOf(t.color);
  const c = { ...base, fur: `url(#${uid}-fur)`, nosePink: hsl(t.color.h - 18, 70, 60) };
  const bodyD = fluffPath(CX, CY, RX, RY, 56, 0.05, rnd);
  const fur = furStrokes(rnd, 84, CX, CY, RX, RY, 6, 12);
  const x1 = CX - t.eyeDx;
  const x2 = CX + t.eyeDx;
  const tail = sp.tail(c, rnd, uid);
  let tailSvg = tail.svg;
  let tailDefs = tail.defs || '';
  if (tail.clip) { // the body casts a soft shadow on the tail and the tail gets the same fur strokes
    const tf = furStrokes(rnd, 40, ...tail.furBox, 5, 10, false);
    tailDefs += `<clipPath id="${uid}-tl"><path d="${tail.clip}"${tail.clipTransform ? ` transform="${tail.clipTransform}"` : ''}/></clipPath>`;
    tailSvg += `<g clip-path="url(#${uid}-tl)"><path d="${bodyD}" transform="translate(8 5)" fill="${c.deep}" opacity=".3"/>${furSvg(tf, c)}</g>`;
  }
  const tailMirror = t.tail < 0;
  const tailPivot = tailMirror ? [240 - tail.pivot[0], tail.pivot[1]] : tail.pivot;
  const tailInner = tailMirror ? `<g transform="translate(240 0) scale(-1 1)">${tailSvg}</g>` : tailSvg;
  const owl = t.species === 'owl';
  const blushR = f1(12 * t.blush);

  return `<svg class="cr-root cr-sp-${t.species} cr-m-idle" viewBox="0 0 240 240" role="img" aria-label="${label}" ` +
    `style="--cr-ph:${f1(t.phase)}s;--cr-sp:${f1(t.tempo * 100) / 100}">` +
    `<defs>` +
    `<radialGradient id="${uid}-fur" gradientUnits="userSpaceOnUse" cx="96" cy="104" r="170"><stop offset="0" stop-color="${base.hi}"/><stop offset=".5" stop-color="${base.base}"/><stop offset="1" stop-color="${base.lo}"/></radialGradient>` +
    `<radialGradient id="${uid}-bl"><stop offset="0" stop-color="${base.blush}" stop-opacity=".85"/><stop offset="1" stop-color="${base.blush}" stop-opacity="0"/></radialGradient>` +
    tailDefs +
    `</defs>` +
    `<g transform="translate(${f1(-t.tail * sp.shift)} 0)">` +
    `<ellipse class="cr-shadow" cx="120" cy="230" rx="62" ry="6" fill="#000" opacity=".26"/>` +
    `<g class="cr-pose">` +
    `<g class="cr-tail ${tailMirror ? 'cr-l' : 'cr-r'}" style="transform-origin:${tailPivot[0]}px ${tailPivot[1]}px">${tailInner}</g>` +
    sp.ears(c, t) +
    `<path class="cr-body" d="${bodyD}" fill="${c.fur}"/>` +
    `<ellipse cx="120" cy="198" rx="48" ry="26" fill="${c.pale}" opacity=".34"/>` +
    furSvg(fur, c) +
    `<ellipse cx="92" cy="98" rx="30" ry="15" fill="#fff" opacity=".13" transform="rotate(-24 92 98)"/>` +
    `<g class="cr-face">` +
    sp.marks(c) +
    `<g class="cr-blush"><ellipse cx="${CX - 63}" cy="${EY + 24}" rx="${blushR + 3}" ry="${f1(blushR * 0.72)}" fill="url(#${uid}-bl)"/><ellipse cx="${CX + 63}" cy="${EY + 24}" rx="${blushR + 3}" ry="${f1(blushR * 0.72)}" fill="url(#${uid}-bl)"/></g>` +
    (sp.whiskers ? sp.whiskers(c) : '') +
    `<g class="cr-eyes">${eyeMarkup('cr-l', x1, c, sp.eye)}${eyeMarkup('cr-r', x2, c, sp.eye)}</g>` +
    closedEyes(x1, x2, sp.eye) +
    browMarkup('cr-l', x1) + browMarkup('cr-r', x2) +
    `<g class="cr-nose">${sp.nose(c)}</g>` +
    `<g class="cr-mouth">${sp.mouth(c)}</g>` +
    `</g>` +
    accessoryMarkup(t) +
    pawMarkup(-1, c, owl) + pawMarkup(1, c, owl) +
    `</g></g>` +
    fxMarkup() +
    `</svg>`;
}

// ---------- CSS ----------

// Long idle timeline (blinks, glances, one eye roll). Times in seconds of a 36 s cycle; the per-avatar tempo stretches it,
// so blink gaps land between 3 and 6 s and no two avatars blink together.
function idleKeyframes() {
  const D = 36;
  const pc = (s) => `${(Math.round((s / D) * 100000) / 1000)}%`;
  const blinks = [1.2, 4.9, 9.4, 13.1, 18.4, 22, 26.7, 30.1, 34];
  let blink = 'cr-blink-keys{0%{transform:scaleY(1)}';
  for (const b of blinks) blink += `${pc(b)}{transform:scaleY(1)}${pc(b + 0.07)}{transform:scaleY(.08)}${pc(b + 0.19)}{transform:scaleY(1)}`;
  blink += '100%{transform:scaleY(1)}}';

  const at = (s, x, y, ease) => `${pc(s)}{transform:translate(${x}px,${y}px)${ease ? ';animation-timing-function:' + ease : ''}}`;
  const look = 'cr-look-keys{0%{transform:translate(0,0)}' +
    at(6.8, 0, 0) + at(7.1, -6, 1.5) + at(8.7, -6, 1.5) + at(9, 0, 0) +
    at(15.6, 0, 0) + at(15.9, 6, -1) + at(17.3, 6, -1) + at(17.6, 0, 0) +
    at(24.3, 0, 0, 'linear') + at(24.55, 6.2, -1.5, 'linear') + at(24.85, 4.4, -6, 'linear') + at(25.15, 0, -8, 'linear') +
    at(25.45, -4.4, -6, 'linear') + at(25.75, -6.2, -1.5, 'linear') + at(26.1, 0, 0) +
    at(31.5, 0, 0) + at(31.8, -4.5, 5) + at(33, -4.5, 5) + at(33.3, 0, 0) +
    '100%{transform:translate(0,0)}}';
  return '@keyframes ' + blink + '\n@keyframes ' + look;
}

const CSS = `
.cr-root{display:block;width:100%;height:100%;overflow:visible;transition:filter .35s;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.cr-brow,.cr-paw,.cr-eye,.cr-pupil,.cr-mouth>*,.cr-fx-dots circle,.cr-fx-bang,.cr-z{transform-box:fill-box;transform-origin:50% 50%}
.cr-root .cr-pose{transform-box:view-box;transform-origin:120px 218px;transition:translate .28s ease-out,rotate .28s ease-out,scale .28s ease-out}
.cr-root .cr-tail,.cr-root .cr-ear{transform-box:view-box}
.cr-root .cr-eyes{transform-box:view-box;transform-origin:120px ${EY}px}
.cr-root .cr-mo-open{transform-origin:50% 0}
.cr-root .cr-fx-bang{transform-origin:50% 100%}
.cr-l{--s:-1}
.cr-r{--s:1}
.cr-brow,.cr-paw,.cr-eye,.cr-pupil,.cr-ear,.cr-tail,.cr-mouth>*{transition:translate .24s ease-out,rotate .24s ease-out,scale .24s ease-out}
.cr-blush{transition:opacity .3s}

.cr-mouth>*,.cr-eyes-closed,.cr-fx>*{display:none}
.cr-m-idle .cr-mo-smile,.cr-m-listening .cr-mo-smile,.cr-m-speaking .cr-mo-open,.cr-m-surprised .cr-mo-o,.cr-m-thinking .cr-mo-hmm,.cr-m-away .cr-mo-zz{display:inline}
.cr-m-away .cr-eyes-closed{display:inline}
.cr-m-away .cr-eyes{display:none}
.cr-m-thinking .cr-fx-dots,.cr-m-surprised .cr-fx-bang,.cr-m-away .cr-fx-zzz{display:inline}

.cr-brow{rotate:calc(var(--s)*4deg)}
.cr-blush{opacity:.7}
.cr-mo-smile{scale:.92}

.cr-m-speaking .cr-brow{translate:0 -3px;rotate:calc(var(--s)*3deg)}
.cr-m-speaking .cr-blush{opacity:1}
.cr-m-speaking .cr-eye{scale:1.03}
.cr-m-speaking .cr-paw-r{translate:8px -40px;rotate:-8deg}
.cr-m-speaking .cr-paw-l{translate:calc(var(--s)*-5px) -3px}

.cr-m-thinking .cr-pose{rotate:10deg;translate:3px 0}
.cr-m-thinking .cr-brow-l{translate:0 -9px;rotate:-11deg}
.cr-m-thinking .cr-brow-r{translate:0 3px;rotate:-10deg}
.cr-m-thinking .cr-eye{scale:1 .93}
.cr-m-thinking .cr-pupil{translate:5px -8.5px}
.cr-m-thinking .cr-paw-r{translate:-27px -16px;rotate:-14deg}
.cr-m-thinking .cr-ear-l{rotate:calc(var(--s)*13deg)}
.cr-m-thinking .cr-ear-r{rotate:calc(var(--s)*-4deg);scale:1 1.08}

.cr-m-listening .cr-pose{rotate:-4deg;scale:1.03}
.cr-m-listening .cr-brow{translate:0 -9px;rotate:calc(var(--s)*11deg)}
.cr-m-listening .cr-eye{scale:1.12}
.cr-m-listening .cr-pupil{scale:1.15;translate:0 -2.5px}
.cr-m-listening .cr-blush{opacity:1}
.cr-m-listening .cr-mo-smile{scale:1.3;translate:0 1px}
.cr-m-listening .cr-paw{translate:calc(var(--s)*-30px) 2px}
.cr-m-listening .cr-ear{rotate:calc(var(--s)*5deg);scale:1 1.05}

.cr-m-surprised .cr-brow{translate:0 -16px;rotate:calc(var(--s)*3deg);scale:1 1.2}
.cr-m-surprised .cr-eye{scale:1.3}
.cr-m-surprised .cr-pupil{scale:.62}
.cr-m-surprised .cr-blush{opacity:.35}
.cr-m-surprised .cr-paw{translate:calc(var(--s)*18px) -44px;rotate:calc(var(--s)*14deg)}
.cr-m-surprised .cr-ear{rotate:calc(var(--s)*9deg);scale:1 1.12}
.cr-m-surprised .cr-tail{scale:1.08}

.cr-m-away{filter:saturate(.3) brightness(.7)}
.cr-m-away .cr-pose{translate:0 6px;rotate:3deg;scale:.985}
.cr-m-away .cr-brow{translate:0 5px;rotate:calc(var(--s)*7deg)}
.cr-m-away .cr-blush{opacity:.3}
.cr-m-away .cr-ear{rotate:calc(var(--s)*26deg);scale:1 .9}
.cr-m-away .cr-tail{rotate:calc(var(--s)*8deg)}
.cr-m-away .cr-paw{translate:calc(var(--s)*-12px) 5px}

.cr-root .cr-pose{animation:cr-breathe calc(4.4s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-root .cr-eyes{animation:cr-blink-keys calc(36s*var(--cr-sp)) linear var(--cr-ph) infinite}
.cr-root .cr-tail{animation:cr-tail calc(3.6s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-idle .cr-pupil{animation:cr-look-keys calc(36s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-idle .cr-ear-l{animation:cr-flick calc(17s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-idle .cr-ear-r{animation:cr-flick calc(13s*var(--cr-sp)) ease-in-out calc(var(--cr-ph) - 5s) infinite}

.cr-m-speaking .cr-pose{animation:cr-bob calc(.5s*var(--cr-sp)) linear var(--cr-ph) infinite}
.cr-m-speaking .cr-mo-open{animation:cr-flap calc(.5s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-speaking .cr-brow{animation:cr-brow-talk calc(1s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-speaking .cr-paw-r{animation:cr-gesture calc(1.5s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-speaking .cr-paw-l{animation:cr-gesture-s calc(1.1s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-speaking .cr-ear{animation:cr-ear-bob calc(.5s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-speaking .cr-tail{animation:cr-wag calc(.9s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}

.cr-m-thinking .cr-pose{animation:cr-sway calc(3.8s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-thinking .cr-paw-r{animation:cr-tap calc(1.3s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-fx-dots circle{animation:cr-dot 1.2s ease-in-out infinite}
.cr-fx-dots circle:nth-of-type(2){animation-delay:.2s}
.cr-fx-dots circle:nth-of-type(3){animation-delay:.4s}

.cr-m-listening .cr-pose{animation:cr-nod calc(1s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-listening .cr-eye{animation:cr-eye-nod calc(1s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}

.cr-m-surprised .cr-brow,.cr-m-surprised .cr-eye,.cr-m-surprised .cr-pupil,.cr-m-surprised .cr-paw,.cr-m-surprised .cr-ear,.cr-m-surprised .cr-tail,.cr-m-surprised .cr-mouth>*{transition-duration:.07s}
.cr-m-surprised .cr-pose{animation:cr-hop 1.2s ease-out 0s 1 both}
.cr-m-surprised .cr-eyes,.cr-m-surprised .cr-tail{animation:none}
.cr-m-surprised .cr-fx-bang{animation:cr-bang .5s cubic-bezier(.3,1.6,.5,1) 0s 1 both}

.cr-m-away .cr-pose{animation:cr-doze calc(5s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-m-away .cr-eyes,.cr-m-away .cr-tail{animation:none}
.cr-m-away .cr-mo-zz{animation:cr-snore calc(5s*var(--cr-sp)) ease-in-out var(--cr-ph) infinite}
.cr-z{animation:cr-z 3.2s ease-in-out infinite}
.cr-z1{animation-delay:-.5s}
.cr-z2{animation-delay:-1.6s}
.cr-z3{animation-delay:-2.7s}

@keyframes cr-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,1.022)}}
@keyframes cr-doze{0%,100%{transform:scale(1,1)}50%{transform:scale(1.014,1.03)}}
@keyframes cr-bob{0%,100%{transform:translateY(0)}17%{transform:translateY(-3.5px)}33%{transform:translateY(0)}50%{transform:translateY(-2px)}67%{transform:translateY(.5px)}83%{transform:translateY(-3px)}}
@keyframes cr-nod{0%,62%,100%{transform:translateY(0) rotate(0) scale(1,1)}30%{transform:translateY(7px) rotate(2.2deg) scale(1.015,.965)}}
@keyframes cr-eye-nod{0%,62%,100%{transform:scaleY(1)}30%{transform:scaleY(.72)}}
@keyframes cr-sway{0%,100%{transform:rotate(-1.2deg)}50%{transform:rotate(1.4deg)}}
@keyframes cr-hop{0%{transform:scale(1,1) translateY(0)}8%{transform:scale(1.08,.9) translateY(0)}26%{transform:scale(.95,1.08) translateY(-18px) rotate(-3deg)}44%{transform:scale(1.07,.93) translateY(0)}56%{transform:scale(.99,1.02) translateY(-7px)}68%{transform:scale(1.03,.97) translateY(0)}78%{transform:scale(1,1) translateY(-2px)}100%{transform:scale(1,1) translateY(0)}}
@keyframes cr-flap{0%,67%,100%{transform:scale(1.06,.3)}17%{transform:scale(.96,1)}33%{transform:scale(1.05,.36)}50%{transform:scale(1,.64)}83%{transform:scale(.97,.92)}}
@keyframes cr-brow-talk{0%,100%{transform:translateY(0)}30%{transform:translateY(-3px)}60%{transform:translateY(.5px)}}
@keyframes cr-gesture{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-7px) rotate(-14deg)}50%{transform:translateY(2px) rotate(10deg)}75%{transform:translateY(-5px) rotate(-10deg)}}
@keyframes cr-gesture-s{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px) rotate(6deg)}}
@keyframes cr-tap{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(2.5px) rotate(-6deg)}}
@keyframes cr-ear-bob{0%,100%{transform:rotate(0)}25%{transform:rotate(calc(var(--s)*3deg))}60%{transform:rotate(calc(var(--s)*-1.5deg))}}
@keyframes cr-flick{0%,84%,100%{transform:rotate(0)}88%{transform:rotate(calc(var(--s)*11deg))}91%{transform:rotate(calc(var(--s)*-2deg))}94%{transform:rotate(calc(var(--s)*6deg))}}
@keyframes cr-tail{0%,100%{transform:rotate(calc(var(--s)*-3deg))}50%{transform:rotate(calc(var(--s)*4deg))}}
@keyframes cr-wag{0%,100%{transform:rotate(calc(var(--s)*-6deg))}50%{transform:rotate(calc(var(--s)*9deg))}}
@keyframes cr-dot{0%,100%{opacity:.45;transform:scale(1)}35%{opacity:1;transform:scale(1.35)}}
@keyframes cr-bang{0%{transform:scale(.1);opacity:0}60%{transform:scale(1.25);opacity:1}100%{transform:scale(1);opacity:1}}
@keyframes cr-snore{0%,100%{transform:scale(.8)}50%{transform:scale(1.25)}}
@keyframes cr-z{0%{opacity:0;transform:translate(0,8px) scale(.6)}15%{opacity:1}75%{opacity:1}100%{opacity:0;transform:translate(8px,-12px) scale(1.12)}}
${idleKeyframes()}
@media (prefers-reduced-motion:reduce){.cr-root,.cr-root *{animation:none!important;transition:none!important}}
`;

function ensureStyle() {
  if (document.getElementById('cr-style')) return;
  const el = document.createElement('style');
  el.id = 'cr-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

export function create({ seed = '', look = {}, label } = {}) {
  ensureStyle();
  const uid = 'cr' + (++serial);
  const tpl = document.createElement('template');
  tpl.innerHTML = build(traitsOf({ seed, look }), uid, esc(label || seed || 'avatar'));
  const el = tpl.content.firstElementChild;
  let mood = 'idle';
  return {
    el,
    get mood() { return mood; },
    setMood(next) {
      const m = MOODS.includes(next) ? next : 'idle';
      if (m === mood) return;
      el.classList.remove('cr-m-' + mood);
      el.classList.add('cr-m-' + m);
      mood = m;
    },
    destroy() { el.remove(); },
  };
}
