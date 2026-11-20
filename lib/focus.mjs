// Decides who an utterance is for. Pure functions: no I/O, no clock.
//
// Text is matched in a "spaced" form: NFKC, lower case, number words as digits, every run of
// separators as one space. Latin keys need word boundaries, so "ops" does not fire inside "stops"
// and "05" does not fire inside "2026-01-05". Text a reference has used up is blanked out, so
// "Labs-01" does not also count as the bare number 01.

const MARK = '\u0001'; // glue inside a number ("0.5", "09:30"): keeps it from reading as "05" or "09"
const BLANK = '\u0000'; // overwrites text that an exact reference has already used up
const WORD = `a-z0-9${MARK}`; // characters of a Latin word or a number
const PARTICLE_NO = '\u306e'; // Japanese possessive particle, as in "<reading> no <pane>"
const COUNTER_BAN = '\u756a'; // counter word: "<N> ban" means number N
const MIN_PREFIX = 4; // loose: a typed word this long that starts a key
const MIN_FUZZY_KEY = 5; // loose: keys this long may differ by one edit

// Number words, index = digit (Katakana readings and Kanji digits)
const LATIN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const KATAKANA = ['\u30bc\u30ed', '\u30a4\u30c1', '\u30cb', '\u30b5\u30f3', '\u30e8\u30f3', '\u30b4', '\u30ed\u30af', '\u30ca\u30ca', '\u30cf\u30c1', '\u30ad\u30e5\u30a6'];
const KANJI = ['\u3007', '\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d', '\u4e03', '\u516b', '\u4e5d'];
const DIGIT = new Map([LATIN, KATAKANA, KANJI].flatMap((words) => words.map((w, i) => [w, String(i)])));
// Kanji "one" right before the counter word is the everyday word for "best", not a number
const KANJI_WORDS = KANJI.map((k) => (k === '\u4e00' ? `${k}(?!${COUNTER_BAN})` : k));
const NUMBER_WORD = `(?:(?<![a-z])(?:${LATIN.join('|')})(?![a-z])|${[...KATAKANA, ...KANJI_WORDS].join('|')})`;
const NUMBER_RUN = new RegExp(`${NUMBER_WORD}(?:\\s*${NUMBER_WORD})*`, 'g'); // "zero one", "zero five" -> 01, 05
const NUMBER_ONE = new RegExp(NUMBER_WORD, 'g');

const WORD_CHAR = new RegExp(`[${WORD}]`);
const STRIP = new RegExp(`[ ${MARK}]`, 'g');
// A bare zero-padded 01-09, and "<N> ban"; a lone digit is never a reference
const BARE = new RegExp(`(?<![${WORD}])0([1-9])(?![${WORD}])`, 'g');
const COUNTER = new RegExp(`(?<![0-9${MARK}])([0-9]+)${COUNTER_BAN}`, 'g');

function fold(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(NUMBER_RUN, (run) => run.replace(NUMBER_ONE, (w) => DIGIT.get(w)).replace(/\s+/g, ''))
    .replace(/(?<=\d)[.,:/-](?=\d)/g, MARK)
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}

export function normalize(text) {
  return fold(text).replace(STRIP, '');
}

// A key is a list of pieces; exact matching allows one optional space between pieces
const piecesOf = (text) => fold(text).split(' ').filter(Boolean);
const flat = (pieces) => pieces.join('').replace(STRIP, '');
const usable = (pieces) => {
  const f = flat(pieces);
  return f.length >= 2 && /\D/.test(f); // not a lone character, not just a number
};

function readingsOf(session, sessionReadings) {
  const want = normalize(session);
  const extra = Object.entries(sessionReadings || {})
    .filter(([name]) => normalize(name) === want)
    .flatMap(([, list]) => list);
  return [session, ...extra];
}

// Whole-name keys: name, title, label, aliases. Part keys: the pieces of a hyphenated name, so
// "hq" reaches "Labs-HQ". A piece that is a number or the tmux session word ("labs") is not a
// key alone: numbers go through numbersOf and the session word names a whole group.
// Address keys: <reading> [no] <pane>, pane as 5 or 05.
function keyDefs(p, sessionReadings) {
  const readings = p.address?.session ? readingsOf(p.address.session, sessionReadings) : [];
  const own = new Set(readings.flatMap(piecesOf));
  const names = [];
  const parts = [];
  for (const source of [p.name, p.title, p.label]) {
    const pieces = piecesOf(source);
    names.push(pieces);
    if (pieces.length > 1) for (const piece of pieces) if (!own.has(piece)) parts.push([piece]);
  }
  for (const alias of [].concat(p.aliases ?? [])) names.push(piecesOf(alias));

  const addresses = [];
  const pane = p.address?.pane;
  if (Number.isInteger(pane)) {
    const forms = [...new Set([String(pane), String(pane).padStart(2, '0')])];
    for (const reading of readings) {
      const head = piecesOf(reading);
      if (!usable(head)) continue; // a one-letter or all-digit session ("0") would match everyday text
      for (const n of forms) addresses.push([...head, n], [...head, PARTICLE_NO, n]);
    }
  }
  return { names: names.filter(usable), parts: parts.filter(usable), addresses, own };
}

// Every normalized key the participant answers to. Bare numbers ("01", "5 ban") are not keys;
// resolve matches them against numbersOf.
export function keysOf(participant, { sessionReadings } = {}) {
  const { names, parts, addresses } = keyDefs(participant, sessionReadings);
  return [...new Set([...names, ...parts, ...addresses].map(flat))];
}

// Numbers a bare "01" or "<N> ban" can mean: the tmux pane, and a trailing number in the name or title
function numbersOf(p) {
  const out = new Set();
  if (Number.isInteger(p.address?.pane)) out.add(p.address.pane);
  for (const source of [p.name, p.title]) {
    const last = piecesOf(source).at(-1);
    if (last && /^\d+$/.test(last)) out.add(Number(last));
  }
  return out;
}

// Pieces hold no punctuation or symbols (fold turns them into spaces), so they are safe inside a RegExp
function pattern(pieces, flags = 'g') {
  const head = WORD_CHAR.test(pieces[0][0]) ? `(?<![${WORD}])` : '';
  const tail = WORD_CHAR.test(pieces.at(-1).at(-1)) ? `(?![${WORD}])` : '';
  return new RegExp(head + pieces.join(' ?') + tail, flags);
}

const mentions = (spaced, words) => words.some((w) => {
  const pieces = piecesOf(w);
  return pieces.length > 0 && pattern(pieces, '').test(spaced);
});

// Names of the people the text refers to clearly. Whole names and addresses go before pieces of
// names, longest first, and each blanks out what it matched, so a specific reference hides the
// weaker ones inside it ("alpha-beta" is not also "beta").
function exactRefs(spaced, people, sessionReadings) {
  const defs = new Map();
  const numbers = new Map();
  for (const p of people) {
    numbers.set(p.name, numbersOf(p));
    const { names, parts, addresses } = keyDefs(p, sessionReadings);
    for (const [rank, keys] of [[0, [...names, ...addresses]], [1, parts]]) {
      for (const pieces of keys) {
        const id = `${rank}:${pieces.join(' ')}`;
        if (!defs.has(id)) defs.set(id, { rank, pieces, owners: new Set() });
        defs.get(id).owners.add(p.name);
      }
    }
  }
  const hit = new Set();
  let rest = spaced;
  const consume = (re, onMatch) => {
    rest = rest.replace(re, (m, group) => {
      onMatch(group);
      return BLANK.repeat(m.length);
    });
  };
  const byNumber = (n) => {
    for (const [name, set] of numbers) if (set.has(n)) hit.add(name);
  };

  const ordered = [...defs.values()].sort((a, b) => a.rank - b.rank || flat(b.pieces).length - flat(a.pieces).length);
  for (const { pieces, owners } of ordered) consume(pattern(pieces), () => owners.forEach((n) => hit.add(n)));
  consume(COUNTER, (digits) => byNumber(Number(digits)));
  consume(BARE, (digit) => byNumber(Number(digit)));
  return hit;
}

// Exactly one insertion, deletion or substitution apart
function oneEdit(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Names the text only resembles: a typed word that starts a name key, or is one edit away from one.
// Whole words only (never a piece of a longer word), only Latin keys, and never the session word ("labs").
function looseRefs(spaced, people, sessionReadings) {
  const words = (spaced.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= MIN_PREFIX);
  if (!words.length) return [];
  return people
    .filter((p) => {
      const { names, parts, own } = keyDefs(p, sessionReadings);
      const keys = [...names, ...parts].map(flat).filter((k) => /^[a-z0-9]+$/.test(k));
      return words.some((w) => !own.has(w) && keys.some((k) => (k.length > w.length && k.startsWith(w)) || (k.length >= MIN_FUZZY_KEY && oneEdit(w, k))));
    })
    .map((p) => p.name);
}

// Live sessions that the text asks to bring in: an invite word plus an exact reference.
// `live` is expected to hold only sessions outside the meeting; `participants` also excludes any that joined.
export function findInvites({ text, live = [], inviteWords = [], sessionReadings, participants = [] }) {
  const spaced = fold(text);
  if (!mentions(spaced, inviteWords)) return [];
  const joined = new Set(participants.map((p) => p.name));
  const outside = live.filter((s) => !joined.has(s.name));
  const hit = exactRefs(spaced, outside, sessionReadings);
  return outside.filter((s) => hit.has(s.name)).map((s) => s.name);
}

// Rules in order: aside, everyone, exact references, loose references, then focus or chair.
// `invite` is filled only when `live` and `inviteWords` are passed (see findInvites).
export function resolve({ text, participants = [], focus = [], chairName, everyoneWords = ['everyone'], sessionReadings, aside, live, inviteWords }) {
  const names = participants.map((p) => p.name);
  const known = new Set(names);
  const current = [...(focus ?? [])].filter((n) => known.has(n)); // names of people who left drop out
  const chair = known.has(chairName) ? [chairName] : [];
  const invite = live && inviteWords ? findInvites({ text, live, inviteWords, sessionReadings, participants }) : [];
  const result = (to, maybe, nextFocus) => ({ to, maybe, focus: nextFocus, invite });

  if (aside && known.has(aside)) return result([aside], [], current);

  const spaced = fold(text);
  if (mentions(spaced, everyoneWords)) return result(names, [], [...names]);

  const exact = exactRefs(spaced, participants, sessionReadings);
  if (exact.size) {
    const to = names.filter((n) => exact.has(n));
    return result(to, [], [...to]);
  }

  const maybe = looseRefs(spaced, participants, sessionReadings);
  if (maybe.length) return result(chair, maybe, current);

  return result(current.length ? [...current] : chair, [], current);
}
