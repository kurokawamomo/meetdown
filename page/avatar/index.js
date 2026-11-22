// The one avatar the stage uses: Meet's letter circle (or the participant's image).
//
// avatarFor(participant) -> { el, mood, setMood(mood), destroy() }
//   participant: { name, label, look }. The seed is the participant name, so a participant keeps the same colour.

import * as meet from './meet.js';

export function avatarFor(participant) {
  const p = participant || {};
  return meet.create({ seed: p.name || p.label || '', look: p.look || {}, label: p.label || p.name });
}
