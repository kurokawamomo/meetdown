// Captions: what the human said, at the bottom of the stage like Meet's captions. Interim parts of a turn are
// joined as they arrive; the final utterance replaces them. The caption fades a while after the last change.

import { initialOf } from './avatar/meet.js';

const SHOW_MS = 7000;

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

  const turns = new Map(); // turn -> Map(part -> text)
  let timer = 0;
  function show(t) {
    const owner = (store.state.me && store.state.me.owner) || '';
    badge.textContent = initialOf(owner);
    who.textContent = owner;
    text.textContent = t;
    root.hidden = !t;
    text.scrollTop = text.scrollHeight;
    clearTimeout(timer);
    timer = setTimeout(() => { root.hidden = true; }, SHOW_MS);
  }

  store.on('interim', (d) => {
    if (!d || !d.turn || !d.text) return;
    if (!turns.has(d.turn)) turns.set(d.turn, new Map());
    const parts = turns.get(d.turn);
    parts.set(d.part, d.text);
    if (turns.size > 4) turns.delete(turns.keys().next().value);
    show([...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k)).join(' '));
  });
  store.on('utterance', (u) => {
    if (u && u.from === 'human' && u.kind === 'voice' && u.text) show(u.text);
  });
}
