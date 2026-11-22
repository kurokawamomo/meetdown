// Avatar tastes and the one entry point the stage uses.
//
// avatarFor(participant, tasteOverride) -> { el, mood, setMood(mood), destroy(), taste }
//   participant: { name, label, taste, look }. The seed is the participant name, so a participant keeps the same face.
//   The taste is tasteOverride, else participant.taste, else the default; unknown ids fall back to the default.

import * as pixel from './pixel.js';
import * as flat from './flat.js';
import * as sticker from './sticker.js';
import * as geo from './geo.js';
import * as meet from './meet.js';

export const tastes = { pixel, flat, sticker, geo, meet };
export const defaultTaste = pixel.id;

const known = (name) => (Object.hasOwn(tastes, name) ? tastes[name] : null);

export function avatarFor(participant, tasteOverride) {
  const p = participant || {};
  const taste = known(tasteOverride) || known(p.taste) || tastes[defaultTaste];
  const avatar = taste.create({ seed: p.name || p.label || '', look: p.look || {}, label: p.label || p.name });
  avatar.taste = taste.id;
  return avatar;
}
