// Avatar tastes and the one entry point the stage uses.
//
// avatarFor(participant, tasteOverride) -> { el, mood, setMood(mood), destroy(), taste }
//   participant: { name, label, taste, look }. The seed is the participant name, so a participant keeps the same face.
//   The taste is tasteOverride, else participant.taste, else the default; unknown ids fall back to the default.

import * as critters from './critters.js';
import * as meet from './meet.js';

export const tastes = { critters, meet };
export const defaultTaste = critters.id;

const known = (name) => (Object.hasOwn(tastes, name) ? tastes[name] : null);

export function avatarFor(participant, tasteOverride) {
  const p = participant || {};
  const taste = known(tasteOverride) || known(p.taste) || tastes[defaultTaste];
  const avatar = taste.create({ seed: p.name || p.label || '', look: p.look || {}, label: p.label || p.name });
  avatar.taste = taste.id;
  return avatar;
}
