// Captions at the bottom of the stage, like Meet's: who is talking (letter circle and name) and what they say.
// The human's interim parts of a turn are joined as they arrive and the final utterance replaces them; an AI
// caption is the sentence that is sounding now. The caption fades a while after the last change.

import { initialOf, colorOf, distinctLetters } from './avatar/meet.js';

const SHOW_MS = 7000;
const HUMAN_COLOR = '#1a73e8';

export function createCaptions(root, { store }) {
  root.className = 'captions';
  root.hidden = true;
  const badge = document.createElement('span');
  badge.className = 'cap-badge';
  const who = document.createElement('span');
  who.className = 'cap-who';
  const text = document.createElement('span');
  text.className = 'cap-text';
  const body = document.createElement('div');
  body.className = 'cap-body';
  body.append(who, text);
  root.append(badge, body);

  let timer = 0;
  function show({ name, letter, color }, t) {
    badge.textContent = letter;
    badge.style.background = color;
    who.textContent = name;
    text.textContent = t;
    root.hidden = !t;
    clearTimeout(timer);
    timer = setTimeout(() => { root.hidden = true; }, SHOW_MS);
  }
  const human = () => {
    const owner = (store.state.me && store.state.me.owner) || '';
    return { name: owner, letter: initialOf(owner), color: HUMAN_COLOR };
  };
  function speaker(name) {
    const people = store.state.participants || [];
    const p = people.find((x) => x.name === name) || { name };
    const look = p.look || {};
    return { name: p.label || p.name, letter: look.letter || distinctLetters(people)[p.name] || initialOf(p.label || p.name), color: colorOf(p.name, look) };
  }

  const turns = new Map(); // turn -> Map(part -> text)
  store.on('interim', (d) => {
    if (!d || !d.turn || !d.text) return;
    if (!turns.has(d.turn)) turns.set(d.turn, new Map());
    const parts = turns.get(d.turn);
    parts.set(d.part, d.text);
    if (turns.size > 4) turns.delete(turns.keys().next().value);
    show(human(), [...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k)).join(' '));
  });
  store.on('utterance', (u) => {
    if (u && u.from === 'human' && u.kind === 'voice' && u.text) show(human(), u.text);
  });

  return { sentence: (from, t) => show(speaker(from), t) };
}
