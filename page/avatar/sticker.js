// Avatar taste "sticker": messenger-sticker mascots. One dark outline, flat fills, big head, tiny body,
// iconic faces (two dark ovals, a nose, a small mouth). Every expression is a class swap on the root.
//
// create({ seed, look, label }) -> { el, mood, setMood(mood), destroy() }
//   el      an <svg> (viewBox 0 0 240 240) that fills the square box its parent gives it
//   look    optional overrides: { species, color, accessory, accessoryColor, tail }
//           species fox | cat | bear | rabbit | owl, color '#rrggbb',
//           accessory bowtie | ribbon | glasses | scarf | hat | none, tail 'left' | 'right'
// traitsOf({ seed, look }) returns the chosen traits without touching the DOM.

import { MOODS } from './mood.js';

export const id = 'sticker';
export const SPECIES = ['fox', 'cat', 'bear', 'rabbit', 'owl'];
export const ACCESSORIES = ['bowtie', 'ribbon', 'glasses', 'scarf', 'hat', 'none'];

const INK = '#2a2129';
const HUES = [352, 8, 24, 40, 138, 166, 190, 208, 232, 262, 292, 324];
const EX = 31; // eye spacing from centre
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
const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 4, 98))}%)`;

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
  const rnd = mulberry32(hash32('st|' + String(seed)));
  const r = Array.from({ length: 12 }, rnd); // fixed draw order: overriding one trait never shifts the others
  const l = look || {};
  const species = SPECIES.includes(l.species) ? l.species : SPECIES[Math.floor(r[0] * SPECIES.length)];
  const accessory = ACCESSORIES.includes(l.accessory) ? l.accessory : ACCESSORIES[Math.floor(r[1] * ACCESSORIES.length)];
  const color = toHsl(l.color) || { h: HUES[Math.floor(r[2] * HUES.length)] + (r[3] - 0.5) * 10, s: 60 + r[4] * 16, l: 76 + r[5] * 6 };
  return {
    key: String(seed),
    species,
    accessory,
    color,
    accessoryColor: toHsl(l.accessoryColor) || null,
    tail: l.tail === 'left' ? -1 : l.tail === 'right' ? 1 : species === 'fox' ? 1 : r[6] < 0.5 ? 1 : -1,
    delay: -(r[7] * 6),
    blinkEvery: 5.6 + r[8] * 2.6,
  };
}

// ---------- geometry ----------

const ell = (cx, cy, rx, ry) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;

const HEAD = {
  // wide cheeks with two points: the fox silhouette
  fox: 'M120 46C158 46 192 62 193 102Q194 112 200 119L216 132Q219 137 213 142L194 158Q172 176 120 176Q68 176 46 158L27 142Q21 137 24 132L40 119Q46 112 47 102C48 62 82 46 120 46Z',
  cat: ell(120, 110, 80, 64),
  bear: ell(120, 110, 78, 66),
  rabbit: ell(120, 112, 72, 64),
  owl: ell(120, 110, 80, 64),
};

// Left ears; the right one is the same shape mirrored.
const EARS = {
  fox: { out: 'M46 100Q36 56 52 12Q55 8 60 11Q96 26 114 54Z', inn: 'M56 86Q52 54 58 30Q80 40 98 58Z' },
  cat: { out: 'M44 96Q36 62 48 34Q51 30 55 33Q92 46 110 58Z', inn: 'M54 84Q50 62 56 48Q76 56 94 66Z' },
  bear: { out: ell(62, 62, 23, 22), inn: ell(63, 64, 12, 11) },
  rabbit: { out: 'M70 76C56 56 56 22 72 10C88 0 100 20 98 48Q97 62 96 74Z', inn: 'M74 66C66 50 66 28 74 20C84 14 90 30 88 48Q87 58 86 66Z' },
  owl: { out: 'M54 84Q46 62 56 42Q59 39 63 42Q86 52 98 64Z', inn: '' },
};

const TAIL = {
  fox: 'M138 206C160 234 214 236 230 192C242 160 234 124 212 102Q203 94 194 104Q186 114 198 134C206 154 190 184 160 192Z',
  bear: ell(160, 214, 15, 15),
  rabbit: ell(158, 214, 17, 17),
  cat: 'M148 214Q214 226 214 172Q214 150 196 150',
  owl: '',
};

const m = (s) => `<g transform="translate(240 0) scale(-1 1)">${s}</g>`;

function faceBits(sp, pale) {
  // flat patches inside the head (no outline of their own); clipped to the head shape
  if (sp === 'fox') return `<ellipse cx="120" cy="168" rx="96" ry="42" fill="${pale}"/>`;
  if (sp === 'cat') return `<ellipse cx="120" cy="140" rx="26" ry="17" fill="${pale}"/>`;
  if (sp === 'bear') return `<ellipse cx="120" cy="140" rx="30" ry="23" fill="${pale}"/>`;
  if (sp === 'rabbit') return `<ellipse cx="120" cy="142" rx="24" ry="16" fill="${pale}"/>`;
  return `<circle cx="${120 - EX}" cy="110" r="29" fill="${pale}"/><circle cx="${120 + EX}" cy="110" r="29" fill="${pale}"/>`;
}

function accessorySvg(kind, col, uid) {
  const dark = '#2a2630';
  const hl = 'fill="#fff" fill-opacity=".28"';
  if (kind === 'bowtie') {
    const c = col || dark;
    return `<g class="st-acc"><path d="M120 184L84 168Q78 184 84 200Z" fill="${c}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M120 184L156 168Q162 184 156 200Z" fill="${c}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M92 176L110 183L92 181Z" ${hl}/><path d="M148 176L130 183L148 181Z" ${hl}/>` +
      `<rect x="112" y="174" width="16" height="22" rx="7" fill="${c}" stroke="${INK}" stroke-width="5"/></g>`;
  }
  if (kind === 'ribbon') {
    const c = col;
    return `<g class="st-acc" transform="translate(166 62) rotate(18)"><path d="M0 0L-26 -16Q-32 0 -26 16Z" fill="${c}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M0 0L26 -16Q32 0 26 16Z" fill="${c}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
      `<circle r="9" fill="${c}" stroke="${INK}" stroke-width="5"/></g>`;
  }
  if (kind === 'glasses') {
    return `<g class="st-acc"><circle cx="${120 - EX}" cy="112" r="21" fill="#fff" fill-opacity=".22" stroke="${INK}" stroke-width="5"/>` +
      `<circle cx="${120 + EX}" cy="112" r="21" fill="#fff" fill-opacity=".22" stroke="${INK}" stroke-width="5"/>` +
      `<path d="M${120 - EX + 20} 108Q120 100 ${120 + EX - 20} 108" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` +
      `<path d="M${120 - EX - 14} 100Q${120 - EX - 8} 96 ${120 - EX - 2} 97" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="3" stroke-linecap="round"/></g>`;
  }
  if (kind === 'scarf') {
    return `<g class="st-acc"><path d="M148 184L158 224L180 218L168 182Z" fill="${col}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M158 208L176 204" stroke="#fff" stroke-opacity=".45" stroke-width="5" stroke-linecap="round"/>` +
      `<path d="M68 172Q120 198 172 172Q176 192 168 194Q120 214 72 194Q64 192 68 172Z" fill="${col}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M84 184Q120 198 156 184" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="5" stroke-linecap="round"/></g>`;
  }
  if (kind === 'hat') {
    return `<g class="st-acc" transform="rotate(6 120 48)"><path d="M98 52L120 6L142 52Q120 60 98 52Z" fill="${col}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M108 34Q120 39 132 34" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="5" stroke-linecap="round"/>` +
      `<circle cx="120" cy="8" r="9" fill="#fff" stroke="${INK}" stroke-width="5"/></g>`;
  }
  return '';
}

function build(t, uid) {
  const { h, s, l } = t.color;
  const base = hsl(h, s, l);
  const pale = hsl(h, clamp(s + 6, 0, 85), 95);
  const inner = hsl(h - 6, clamp(s + 12, 0, 90), clamp(l + 8, 0, 90));
  const blush = hsl(h - 14, 90, 68);
  const accent = hsl(t.color.h + 150, 68, 62);
  const accCol = t.accessoryColor ? hsl(t.accessoryColor.h, t.accessoryColor.s, t.accessoryColor.l) : t.accessory === 'bowtie' ? null : accent;
  const sp = t.species;
  const stroke = `stroke="${INK}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"`;
  const owl = sp === 'owl';
  const ey = owl ? 110 : 112;
  const earShape = EARS[sp];
  const earL = `<g class="st-ear st-ear-l" style="transform-origin:78px 70px"><path d="${earShape.out}" fill="${base}" ${stroke}/>${earShape.inn ? `<path d="${earShape.inn}" fill="${inner}"/>` : ''}</g>`;
  const earR = `<g class="st-ear st-ear-r" style="transform-origin:162px 70px">${m(`<path d="${earShape.out}" fill="${base}" ${stroke}/>${earShape.inn ? `<path d="${earShape.inn}" fill="${inner}"/>` : ''}`)}</g>`;

  // tail
  let tail = '';
  if (sp === 'fox') {
    tail = `<g class="st-tail" style="transform-origin:150px 206px"><clipPath id="${uid}-tc"><path d="${TAIL.fox}"/></clipPath>` +
      `<path d="${TAIL.fox}" fill="${base}"/><ellipse cx="214" cy="100" rx="34" ry="30" fill="${pale}" clip-path="url(#${uid}-tc)"/>` +
      `<path d="${TAIL.fox}" fill="none" ${stroke}/></g>`;
  } else if (sp === 'cat') {
    tail = `<g class="st-tail" style="transform-origin:150px 214px"><path d="${TAIL.cat}" fill="none" stroke="${INK}" stroke-width="19" stroke-linecap="round"/>` +
      `<path d="${TAIL.cat}" fill="none" stroke="${base}" stroke-width="9" stroke-linecap="round"/></g>`;
  } else if (TAIL[sp]) {
    tail = `<g class="st-tail" style="transform-origin:150px 214px"><path d="${TAIL[sp]}" fill="${sp === 'rabbit' ? '#fff' : base}" ${stroke}/></g>`;
  }
  tail = `<g transform="${t.tail < 0 ? 'translate(240 0) scale(-1 1)' : ''}">${tail}</g>`;

  const body = `<g class="st-body"><ellipse cx="96" cy="222" rx="18" ry="10" fill="${base}" ${stroke}/><ellipse cx="144" cy="222" rx="18" ry="10" fill="${base}" ${stroke}/>` +
    `<path d="${ell(120, 198, 41, 31)}" fill="${base}" ${stroke}/><ellipse cx="120" cy="206" rx="25" ry="19" fill="${pale}"/></g>`;

  const armL = `<g class="st-arm st-arm-l" style="transform-origin:86px 186px"><ellipse cx="78" cy="198" rx="11" ry="18" transform="rotate(16 78 198)" fill="${base}" ${stroke}/></g>`;
  const armR = `<g class="st-arm st-arm-r" style="transform-origin:154px 186px"><ellipse cx="162" cy="198" rx="11" ry="18" transform="rotate(-16 162 198)" fill="${base}" ${stroke}/></g>`;

  const eye = (cx, side) => `<g class="st-eye st-eye-${side}" style="transform-origin:${cx}px ${ey}px"><g class="st-lid" style="transform-origin:${cx}px ${ey}px">` +
    `<ellipse cx="${cx}" cy="${ey}" rx="${owl ? 9 : 8}" ry="${owl ? 11 : 10}" fill="${INK}"/>` +
    `<circle cx="${cx - 2.6}" cy="${ey - 3.6}" r="3.2" fill="#fff"/><circle cx="${cx + 2.6}" cy="${ey + 3.8}" r="1.5" fill="#fff"/></g></g>`;
  const shut = (cx) => `<path d="M${cx - 9} ${ey}Q${cx} ${ey + 8} ${cx + 9} ${ey}" fill="none" stroke="${INK}" stroke-width="4.2" stroke-linecap="round"/>`;
  const brow = (cx, side) => `<path class="st-brow st-brow-${side}" style="transform-origin:${cx}px 92px" d="M${cx - 10} 93Q${cx} ${side === 'l' ? 87 : 87} ${cx + 10} 93" fill="none" stroke="${INK}" stroke-width="4.2" stroke-linecap="round"/>`;

  const ny = owl ? 124 : 127;
  const nose = owl
    ? `<path d="M111 121Q120 118 129 121L120 138Z" fill="#f5b53c" ${stroke}/>`
    : `<ellipse cx="120" cy="${ny}" rx="7" ry="5" fill="${INK}"/><ellipse cx="118" cy="${ny - 1.6}" rx="2.2" ry="1.2" fill="#fff" fill-opacity=".7"/>`;
  const mo = owl ? 8 : 0; // owl: mouth sits under the beak
  const mouth = (owl ? '' : `<path class="st-m-smile" d="M109 ${137} Q114.5 144 120 138 Q125.5 144 131 137" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path class="st-m-soft" d="M107 ${136} Q120 152 133 136" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>` +
      `<path class="st-m-flat" d="M113 141L127 139" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`) +
    `<g transform="translate(0 ${mo})"><g class="st-m-open" style="transform-origin:120px 134px"><path d="M106 134Q120 132 134 134Q133 156 120 156Q107 156 106 134Z" fill="${INK}"/>` +
      `<ellipse cx="120" cy="150.5" rx="8" ry="4.6" fill="#ee7c86"/></g></g>` +
    `<ellipse class="st-m-o" cx="120" cy="${144 + mo}" rx="6.5" ry="8.5" fill="${INK}"/>`;

  const face = `${faceBits(sp, pale)}`;
  const headG = `<g class="st-head" style="transform-origin:120px 176px">` +
    `${earL}${earR}` +
    `<clipPath id="${uid}-hc"><path d="${HEAD[sp]}"/></clipPath>` +
    `<path d="${HEAD[sp]}" fill="${base}"/>` +
    `<g clip-path="url(#${uid}-hc)">${face}</g>` +
    `<path d="${HEAD[sp]}" fill="none" ${stroke}/>` +
    `<ellipse cx="${120 - EX - 14}" cy="${ey + 18}" rx="9" ry="5.5" fill="${blush}" fill-opacity=".6"/><ellipse cx="${120 + EX + 14}" cy="${ey + 18}" rx="9" ry="5.5" fill="${blush}" fill-opacity=".6"/>` +
    `<g class="st-brows">${brow(120 - EX, 'l')}${brow(120 + EX, 'r')}</g>` +
    `<g class="st-eyes">${eye(120 - EX, 'l')}${eye(120 + EX, 'r')}<g class="st-shut">${shut(120 - EX)}${shut(120 + EX)}</g></g>` +
    `${nose}<g class="st-mouth">${mouth}</g>` +
    `${accessorySvg(t.accessory, accCol, uid)}</g>`;

  // thinking: paw at the chin, thought dots
  const paw = `<g class="st-paw"><ellipse cx="160" cy="190" rx="11" ry="21" transform="rotate(-26 160 190)" fill="${base}" ${stroke}/>` +
    `<ellipse cx="146" cy="168" rx="13" ry="12" fill="${base}" ${stroke}/></g>`;
  const dots = `<g class="st-dots"><circle class="st-dot1" cx="186" cy="50" r="4.5" fill="#fff" stroke="${INK}" stroke-width="3"/>` +
    `<circle class="st-dot2" cx="201" cy="36" r="6" fill="#fff" stroke="${INK}" stroke-width="3"/>` +
    `<circle class="st-dot3" cx="219" cy="18" r="8" fill="#fff" stroke="${INK}" stroke-width="3"/></g>`;
  const zz = (x, y, k, d) => `<g transform="translate(${x} ${y})"><g class="st-z ${k}" style="animation-delay:${d}s"><path d="M0 0h13l-13 15h13" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M0 0h13l-13 15h13" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g></g>`;
  const zs = `<g class="st-zs">${zz(176, 52, 'st-z1', 0)}${zz(196, 28, 'st-z2', -1.5)}</g>`;
  const burst = `<g class="st-burst" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"><path d="M30 52L16 44"/><path d="M26 76L10 74"/><path d="M210 52L224 44"/><path d="M214 76L230 74"/></g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" class="st-root st-m-idle" overflow="visible" role="img" style="--st-d:${t.delay.toFixed(2)}s;--st-b:${t.blinkEvery.toFixed(2)}s">` +
    `<ellipse class="st-shadow" cx="120" cy="230" rx="62" ry="7" fill="#000" fill-opacity=".3"/>` +
    `<g class="st-hop">${tail}<g class="st-pose">${body}${armL}${armR}${headG}${paw}${dots}${zs}${burst}</g></g></svg>`;
}

// ---------- style ----------

const CSS = `
.st-root { width: 100%; height: 100%; display: block; overflow: visible; --st-sq: 1; }
.st-root * { transform-box: view-box; }
.st-root .st-lid, .st-root .st-eye, .st-root .st-brow, .st-root .st-mouth *, .st-root .st-ear { will-change: transform; }
.st-paw, .st-dots, .st-zs, .st-burst, .st-shut, .st-m-soft, .st-m-flat, .st-m-open, .st-m-o, .st-brows { display: none; }
.st-m-idle .st-m-smile, .st-m-listening .st-m-soft, .st-m-thinking .st-m-flat, .st-m-surprised .st-m-o, .st-m-speaking .st-m-open, .st-m-thinking .st-paw, .st-m-thinking .st-dots, .st-m-away .st-zs, .st-m-away .st-shut, .st-m-surprised .st-burst { display: inline; }
.st-m-listening .st-brows, .st-m-surprised .st-brows, .st-m-thinking .st-brows { display: inline; }
.st-m-away .st-eye, .st-m-away .st-m-smile { display: none; }

/* idle: calm. slow breathing, slow blink, a lazy glance, the tail barely moves */
.st-m-idle .st-pose, .st-m-listening .st-pose, .st-m-speaking .st-pose, .st-m-thinking .st-pose { animation: st-breathe 4.8s ease-in-out infinite; animation-delay: var(--st-d); transform-origin: 120px 226px; }
.st-m-away .st-pose { animation: st-breathe 7s ease-in-out infinite; transform-origin: 120px 226px; }
.st-tail { animation: st-wag 6s ease-in-out infinite; animation-delay: var(--st-d); }
.st-m-away .st-tail { animation: none; }
.st-m-idle .st-lid, .st-m-listening .st-lid, .st-m-speaking .st-lid, .st-m-thinking .st-lid { animation: st-blink var(--st-b) ease-in-out infinite; animation-delay: var(--st-d); }
.st-m-idle .st-eyes { animation: st-glance 13s ease-in-out infinite; animation-delay: var(--st-d); }
.st-m-idle .st-ear-l { animation: st-twitch 9s ease-in-out infinite; animation-delay: var(--st-d); }

/* speaking: mouth ~6 Hz, head bobs a little */
.st-m-speaking .st-m-open { animation: st-talk .1667s ease-in-out infinite; }
.st-m-speaking .st-head { animation: st-bob .333s ease-in-out infinite; }

/* thinking: head tilt, eyes up, paw at the chin, dots */
.st-m-thinking .st-head { transform: rotate(-5deg) translate(-2px, 0); }
.st-m-thinking .st-eyes { transform: translate(5px, -6px); }
.st-m-thinking .st-brow-r { transform: translateY(-5px) rotate(-8deg); }
.st-m-thinking .st-brow-l { transform: translateY(1px); }
.st-m-thinking .st-arm-r { display: none; }
.st-m-thinking .st-dot1 { animation: st-dot 1.8s ease-in-out infinite; }
.st-m-thinking .st-dot2 { animation: st-dot 1.8s ease-in-out infinite .3s; }
.st-m-thinking .st-dot3 { animation: st-dot 1.8s ease-in-out infinite .6s; }

/* listening: gentle nods, soft attentive face */
.st-m-listening .st-head { animation: st-nod 2.6s ease-in-out infinite; }
.st-m-listening .st-eye { transform: scale(1.1); }
.st-m-listening .st-brow { transform: translateY(-4px); }
.st-m-listening .st-eyes { transform: translate(0, 1px); }

/* surprised: wide eyes, brows up, hop once (1.2 s) */
.st-m-surprised .st-hop { animation: st-hop 1.2s ease-out 1 both; transform-origin: 120px 226px; }
.st-m-surprised .st-shadow { animation: st-shadow 1.2s ease-out 1 both; transform-origin: 120px 230px; }
.st-m-surprised .st-eye { transform: scale(1.3); }
.st-m-surprised .st-brow { transform: translateY(-11px); }
.st-m-surprised .st-ear-l { transform: rotate(-9deg); }
.st-m-surprised .st-ear-r { transform: rotate(9deg); }
.st-m-surprised .st-arm-l { transform: rotate(-32deg); }
.st-m-surprised .st-arm-r { transform: rotate(32deg); }
.st-m-surprised .st-burst { animation: st-burst 1.2s ease-out 1 both; }

/* away: eyes shut, dimmed, head sinks, z */
.st-m-away { filter: brightness(.78) saturate(.8); }
.st-m-away .st-head { transform: rotate(5deg) translate(2px, 5px); }
.st-m-away .st-z { animation: st-z 3.2s ease-in-out infinite; }

.st-eye, .st-brow, .st-arm, .st-ear { transition: transform .22s ease-out; }
.st-head { transition: transform .35s ease-out; }
.st-eyes { transition: transform .3s ease-out; }

@keyframes st-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.012, 1.03); } }
@keyframes st-wag { 0%, 100% { transform: rotate(-2.5deg); } 50% { transform: rotate(3deg); } }
@keyframes st-blink { 0%, 93%, 100% { transform: scaleY(1); } 96.5% { transform: scaleY(.1); } }
@keyframes st-glance { 0%, 36%, 100% { transform: translate(0, 0); } 42%, 56% { transform: translate(4px, 0); } 62% { transform: translate(0, 0); } 78%, 86% { transform: translate(-3px, 1px); } 92% { transform: translate(0, 0); } }
@keyframes st-twitch { 0%, 90%, 100% { transform: rotate(0); } 94% { transform: rotate(-5deg); } 97% { transform: rotate(1deg); } }
@keyframes st-talk { 0%, 100% { transform: scaleY(.22); } 50% { transform: scaleY(1); } }
@keyframes st-bob { 0%, 100% { transform: translateY(0) rotate(-.8deg); } 50% { transform: translateY(1.6px) rotate(.8deg); } }
@keyframes st-nod { 0%, 62%, 100% { transform: translateY(0) rotate(0); } 14% { transform: translateY(5px) rotate(1.5deg); } 28% { transform: translateY(0) rotate(0); } 42% { transform: translateY(5px) rotate(1.5deg); } 54% { transform: translateY(0) rotate(0); } }
@keyframes st-dot { 0%, 100% { opacity: .25; transform: scale(.85); } 40%, 60% { opacity: 1; transform: scale(1); } }
@keyframes st-hop { 0% { transform: translateY(0) scale(1.05, .94); } 12% { transform: translateY(0) scale(.96, 1.06); } 30% { transform: translateY(-20px) scale(.97, 1.04); } 50% { transform: translateY(0) scale(1.06, .93); } 62% { transform: translateY(-6px) scale(1, 1); } 76%, 100% { transform: translateY(0) scale(1, 1); } }
@keyframes st-shadow { 0%, 50%, 76%, 100% { transform: scale(1); opacity: 1; } 30% { transform: scale(.78); opacity: .6; } 62% { transform: scale(.92); } }
@keyframes st-burst { 0% { opacity: 0; transform: scale(.7); } 15% { opacity: 1; transform: scale(1); } 70% { opacity: 1; } 100% { opacity: 0; } }
@keyframes st-z { 0% { opacity: 0; transform: translate(0, 10px) scale(.6); } 25% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; transform: translate(10px, -16px) scale(1); } }
@media (prefers-reduced-motion: reduce) { .st-root * { animation-duration: 0s !important; animation-iteration-count: 1 !important; } }
`;

let styleUsers = 0;
let styleEl = null;
function useStyle() {
  if (typeof document === 'undefined') return;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-avatar', 'st');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }
  styleUsers++;
}
function releaseStyle() {
  if (typeof document === 'undefined') return;
  styleUsers = Math.max(0, styleUsers - 1);
  if (!styleUsers && styleEl) { styleEl.remove(); styleEl = null; }
}

export function create({ seed = '', look = {}, label = '' } = {}) {
  const t = traitsOf({ seed, look });
  useStyle();
  const host = document.createElement('div');
  host.innerHTML = build(t, 'st' + (++serial));
  const el = host.firstChild;
  if (label) el.setAttribute('aria-label', label);
  let mood = 'idle';
  let dead = false;
  const api = {
    el,
    get mood() { return mood; },
    setMood(next) {
      if (dead || !MOODS.includes(next) || next === mood) return;
      el.classList.remove('st-m-' + mood);
      mood = next;
      el.classList.add('st-m-' + mood);
    },
    destroy() {
      if (dead) return;
      dead = true;
      el.remove();
      releaseStyle();
    },
  };
  return api;
}
