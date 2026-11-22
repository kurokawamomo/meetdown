import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, keysOf, resolve, resolveBaton, findInvites } from './focus.mjs';

// Japanese test inputs are written as \u escapes (repo rule: English only).
const HOUDI = '\u30cf\u30a6\u30c7\u30a3'; // the chair's nickname, Katakana
const LABO = '\u30e9\u30dc'; // Katakana reading of "labs"
const ROOTO = '\u30eb\u30fc\u30c8'; // Katakana reading of "root"
const NO = '\u306e'; // particle "no" (possessive)
const BAN = '\u756a'; // counter word "ban": "2 ban" = number 2
const ZERO_ICHI = '\u30bc\u30ed\u30a4\u30c1'; // "zero one" in Katakana
const ZERO_GO = '\u30bc\u30ed\u30b4'; // "zero five" in Katakana

// Sessions as in a real meeting. The Claude Code name differs from the pane title on purpose
// (zeta-labs-e5 sits in pane 4 and shows "Labs-04"). foxhound has no tmux address.
const at = (session, pane) => ({ session, window: 0, pane });
const foxhound = { name: 'foxhound', title: 'foxhound', aliases: [HOUDI], chair: true };
const hq = { name: 'Labs-HQ', title: 'Labs-HQ', address: at('labs', 0) };
const labs01 = { name: 'Labs-01', title: 'Labs-01', address: at('labs', 1) };
const e5 = { name: 'zeta-labs-e5', title: 'Labs-04', address: at('labs', 4) };
const kennel = { name: 'watchdog-kennel', title: 'watchdog-kennel', address: at('labs', 5) };
const root01 = { name: 'root-01', title: 'Root-01', address: at('root', 1) };
const ALL = [foxhound, hq, labs01, e5, kennel, root01];
const READINGS = { labs: [LABO, 'labs'], root: [ROOTO] };

const ask = (text, extra = {}) =>
  resolve({ text, participants: ALL, focus: [], chairName: 'foxhound', everyoneWords: ['everyone', 'all of you'], sessionReadings: READINGS, ...extra });
const answer = (to, focus = to, maybe = []) => ({ to, maybe, focus, invite: [] });
const toChair = answer(['foxhound'], []);

// ---- the contract cases ----

test('a name moves the focus: "HQ, how is it going?" -> Labs-HQ', () => {
  assert.deepEqual(ask('HQ, how is it going?'), answer(['Labs-HQ']));
});

test('the next unnamed utterance stays on the focus', () => {
  const first = ask('HQ, how is it going?');
  assert.deepEqual(ask('and when is it done?', { focus: first.focus }), answer(['Labs-HQ']));
});

test('bare 01 reaches every participant numbered 1 (Labs-01 and root-01)', () => {
  assert.deepEqual(ask('what about 01?'), answer(['Labs-01', 'root-01']));
});

test('Katakana "labs no zero-go" reaches watchdog-kennel only', () => {
  assert.deepEqual(ask(LABO + NO + ZERO_GO), answer(['watchdog-kennel']));
});

test('a piece of a hyphenated name is a name: "watchdog" -> watchdog-kennel', () => {
  assert.deepEqual(ask('watchdog'), answer(['watchdog-kennel']));
});

test('bare 04 reaches zeta-labs-e5 through its pane and its title', () => {
  assert.deepEqual(ask('04'), answer(['zeta-labs-e5']));
});

test('"everyone" and "all of you" reach all participants and focus all of them', () => {
  const all = ALL.map((p) => p.name);
  for (const text of ['everyone, listen up', 'what do all of you think?']) {
    assert.deepEqual(ask(text, { focus: ['Labs-01'] }), answer(all));
  }
});

test('a lone digit is not a reference: "make 2 of them" goes to the chair', () => {
  assert.deepEqual(ask('make 2 of them'), toChair);
});

test('"2 ban" means pane 2; nobody has it, so it goes to the chair', () => {
  assert.deepEqual(ask('2' + BAN), toChair);
});

test('loose "watchdo": candidate shown, delivered to the chair, focus untouched', () => {
  assert.deepEqual(ask('watchdo'), answer(['foxhound'], [], ['watchdog-kennel']));
  assert.deepEqual(ask('watchdo', { focus: ['Labs-01'] }), answer(['foxhound'], ['Labs-01'], ['watchdog-kennel']));
});

test('aside wins over names and everyone words, and leaves the focus alone', () => {
  assert.deepEqual(ask('HQ, how is it going?', { aside: 'root-01', focus: ['Labs-01'] }), answer(['root-01'], ['Labs-01']));
  assert.deepEqual(ask('everyone', { aside: 'watchdog-kennel' }), answer(['watchdog-kennel'], []));
});

// ---- ordinary speech must not target anyone ----

const ORDINARY = [
  '2 minutes', '3 things', 'version 1.5', 'version 0.5', 'version 0.1', 'meet at 09:30', 'on 2026-01-05',
  'room 101', 'it costs 5 dollars', 'one of them', 'no one knows', 'someone said so', 'I have two questions',
  'one then two', 'zero. One more time', '\u4e00\u756a\u3044\u3044', // last: the everyday word for "best"
];

test('ordinary speech with numbers or number words targets nobody', () => {
  for (const text of ORDINARY) {
    assert.deepEqual(ask(text), toChair, text);
    assert.deepEqual(ask(text, { focus: ['watchdog-kennel'] }), answer(['watchdog-kennel']), text);
  }
});

test('the session word names a group, so "labs" and "root cause" target nobody', () => {
  assert.deepEqual(ask('labs'), toChair);
  assert.deepEqual(ask('what is the root cause?'), toChair);
});

test('Latin names need word boundaries', () => {
  const people = [{ name: 'ops-helper', title: 'ops-helper' }, { name: 'chair-bot', chair: true }];
  const on = (text) => resolve({ text, participants: people, chairName: 'chair-bot' });
  assert.deepEqual(on('ops, status?').to, ['ops-helper']);
  assert.deepEqual(on('helper, status?').to, ['ops-helper']);
  assert.deepEqual(on('the stops are fine').to, ['chair-bot']);
  assert.deepEqual(on('new laptops arrived').to, ['chair-bot']);
});

// ---- number words and counter words ----

const FORMS = [
  ['zero one', ['Labs-01', 'root-01']],
  ['Zero  Five', ['watchdog-kennel']],
  ['05', ['watchdog-kennel']],
  [ZERO_ICHI, ['Labs-01', 'root-01']],
  ['\u3007\u4e94', ['watchdog-kennel']], // Kanji zero five
  ['\uff10\uff11', ['Labs-01', 'root-01']], // full-width 01
  ['5' + BAN, ['watchdog-kennel']],
  ['5' + BAN + '\u76ee', ['watchdog-kennel']], // "5 ban-me" (fifth)
  ['\u4e94' + BAN, ['watchdog-kennel']], // Kanji five + ban
  ['\u30e8\u30f3' + BAN, ['zeta-labs-e5']], // Katakana four + ban = pane 4
  ['1' + BAN, ['Labs-01', 'root-01']],
  ['\u30bc\u30ed' + BAN, ['Labs-HQ']], // zero + ban = pane 0
  ['01\u306f\u3069\u3046\u601d\u3046?', ['Labs-01', 'root-01']], // "01 wa dou omou?" with no space after the number
];

test('number words and counter words pick participants by number', () => {
  for (const [text, to] of FORMS) assert.deepEqual(ask(text), answer(to), text);
});

test('a lone digit with no counter word is never a reference', () => {
  for (const text of ['5', 'number 5', '1 and 4', 'ask 3 people']) assert.deepEqual(ask(text), toChair, text);
});

// ---- addresses: <reading> no <pane> ----

test('tmux address forms all reach the same session', () => {
  const forms = [
    LABO + NO + '5', LABO + NO + '05', LABO + '05', LABO + ' ' + NO + ' 05', LABO + NO + '5' + BAN,
    'labs 05', 'labs-05', 'labs5', 'labs' + NO + '5',
  ];
  for (const text of forms) assert.deepEqual(ask(text), answer(['watchdog-kennel']), text);
});

test('an address does not match inside a longer number or word', () => {
  for (const text of ['labs 50', 'labs 5pm', 'labs 0.5']) assert.deepEqual(ask(text), toChair, text);
});

test('an explicit name or address is not also counted as a bare number', () => {
  assert.deepEqual(ask('Labs-01'), answer(['Labs-01']));
  assert.deepEqual(ask('Root-01, thoughts?'), answer(['root-01']));
  assert.deepEqual(ask(ROOTO + NO + '01'), answer(['root-01']));
  assert.deepEqual(ask(LABO + NO + ZERO_ICHI), answer(['Labs-01']));
  assert.deepEqual(ask('labs 01 and root 01'), answer(['Labs-01', 'root-01']));
  assert.deepEqual(ask(LABO + NO + '1' + BAN + '\u3068' + ROOTO + NO + '1' + BAN), answer(['Labs-01', 'root-01'])); // "labs 1 and root 1"
});

test('the more specific name wins: a whole name hides the same word inside a longer name', () => {
  const beta = { name: 'beta' };
  const alphaBeta = { name: 'alpha-beta' };
  for (const people of [[beta, alphaBeta], [alphaBeta, beta]]) {
    const to = (text) => resolve({ text, participants: people }).to;
    assert.deepEqual(to('alpha-beta, status?'), ['alpha-beta']);
    assert.deepEqual(to('beta, status?'), ['beta']);
    assert.deepEqual(to('alpha, status?'), ['alpha-beta']);
  }
});

test('name, title, label and alias all reach the participant', () => {
  assert.deepEqual(ask('zeta-labs-e5'), answer(['zeta-labs-e5']));
  assert.deepEqual(ask('Labs-04'), answer(['zeta-labs-e5']));
  assert.deepEqual(ask('e5, are you there?'), answer(['zeta-labs-e5']));
  assert.deepEqual(ask(HOUDI), answer(['foxhound']));
  assert.deepEqual(ask(HOUDI + '\u3001\u805e\u3044\u3066'), answer(['foxhound'])); // alias followed by more words
  const labelled = [{ name: 'worker-x7', label: 'Navigator' }];
  assert.deepEqual(resolve({ text: 'Navigator, status?', participants: labelled }).to, ['worker-x7']);
});

test('hiragana particles are never read as number words', () => {
  assert.deepEqual(ask('HQ\u306b\u805e\u3044\u3066'), answer(['Labs-HQ'])); // "ask HQ" with the particle ni
  assert.equal(normalize('\u306b\u3054\u3055\u3093'), '\u306b\u3054\u3055\u3093');
});

// ---- loose references ----

test('loose: one edit away from a key of 5+ characters, or a 4+ character prefix', () => {
  for (const text of ['watchdoq', 'watchdogs', 'kenel', 'kenn']) {
    assert.deepEqual(ask(text), answer(['foxhound'], [], ['watchdog-kennel']), text);
  }
});

test('loose: too short to count', () => {
  for (const text of ['ken', 'wat', 'hqx', 'hqq']) assert.deepEqual(ask(text), toChair, text);
});

test('an exact reference suppresses loose candidates', () => {
  assert.deepEqual(ask('HQ and watchdo'), answer(['Labs-HQ']));
});

test('loose with no chair (or a chair who is not in the meeting) delivers to nobody', () => {
  assert.deepEqual(ask('watchdo', { chairName: undefined }), answer([], [], ['watchdog-kennel']));
  assert.deepEqual(ask('watchdo', { chairName: 'gone' }), answer([], [], ['watchdog-kennel']));
  assert.deepEqual(ask('plain words', { chairName: undefined }), answer([], []));
});

// ---- focus handling ----

test('the focus drops participants who left; an empty focus falls back to the chair', () => {
  assert.deepEqual(ask('and then?', { focus: ['gone', 'Labs-01'] }), answer(['Labs-01']));
  assert.deepEqual(ask('and then?', { focus: ['gone'] }), toChair);
  assert.deepEqual(ask('and then?', { focus: null }), toChair);
});

test('an aside to someone who is not in the meeting is ignored', () => {
  assert.deepEqual(ask('HQ?', { aside: 'gone' }), answer(['Labs-HQ']));
});

test('everyoneWords default to "everyone" and can be switched off', () => {
  assert.deepEqual(ask('everyone', { everyoneWords: undefined }).to, ALL.map((p) => p.name));
  assert.deepEqual(ask('everyone', { everyoneWords: [] }), toChair);
});

test('a Japanese everyone word matches inside a sentence', () => {
  const r = ask('\u307f\u3093\u306a\u3001\u805e\u3044\u3066', { everyoneWords: ['\u307f\u3093\u306a'] });
  assert.deepEqual(r.to, ALL.map((p) => p.name));
});

test('inputs are not mutated and results do not share arrays', () => {
  const focus = Object.freeze(['Labs-01']);
  const people = ALL.map((p) => Object.freeze({ ...p }));
  const r = ask('and then?', { focus, participants: people });
  assert.deepEqual(r, answer(['Labs-01']));
  assert.notEqual(r.to, r.focus);
  assert.deepEqual(focus, ['Labs-01']);
  const all = ask('everyone');
  assert.notEqual(all.to, all.focus);
});

// ---- normalize ----

test('normalize: case, width and separators', () => {
  assert.equal(normalize('Labs-01'), 'labs01');
  assert.equal(normalize('\uff2c\uff41\uff42\uff53\uff0d\uff10\uff11'), 'labs01'); // full-width "Labs-01"
  assert.equal(normalize('Hello, World!'), 'helloworld');
  assert.equal(normalize('\u30cf\u30a6\u30c7\u30a3\u30fc'), '\u30cf\u30a6\u30c7\u30a3\u30fc'); // the long-vowel mark stays
  assert.equal(normalize(undefined), '');
});

test('normalize: Japanese and English number words become digits', () => {
  assert.equal(normalize(ZERO_ICHI), '01');
  assert.equal(normalize('\u30bc\u30ed \u30b4'), '05');
  assert.equal(normalize('\u3007\u4e94'), '05');
  assert.equal(normalize('zero one'), '01');
  assert.equal(normalize('Zero  Five'), '05');
  assert.equal(normalize('labs\u30b5\u30f3'), 'labs3');
  assert.equal(normalize('\u30cb'), '2');
});

test('normalize: number words inside other words stay put', () => {
  for (const word of ['someone', 'none', 'phone', 'everyone', 'tone']) assert.equal(normalize(word), word);
  assert.equal(normalize('\u4e00\u756a'), '\u4e00\u756a'); // "best", not "1 ban"
});

// ---- keysOf ----

const has = (keys, present, absent = []) => {
  for (const k of present) assert.ok(keys.includes(k), `missing ${k}`);
  for (const k of absent) assert.ok(!keys.includes(k), `unexpected ${k}`);
};

test('keysOf: name, pieces and address forms of watchdog-kennel', () => {
  const keys = keysOf(kennel, { sessionReadings: READINGS });
  has(keys, ['watchdogkennel', 'watchdog', 'kennel', 'labs5', 'labs05', 'labs' + NO + '5', 'labs' + NO + '05', LABO + '5', LABO + '05', LABO + NO + '5', LABO + NO + '05'], ['labs', '05', '5']);
});

test('keysOf: Labs-HQ answers to "hq"; the session word and bare numbers are not keys', () => {
  has(keysOf(hq, { sessionReadings: READINGS }), ['labshq', 'hq', 'labs0', 'labs00'], ['labs', '0']);
  has(keysOf(labs01, { sessionReadings: READINGS }), ['labs01', 'labs1'], ['labs', '01', '1']);
});

test('keysOf: the pane title is a name source of its own', () => {
  has(keysOf(e5, { sessionReadings: READINGS }), ['zetalabse5', 'zeta', 'e5', 'labs04', 'labs4'], ['labs', '04']);
  has(keysOf(root01, { sessionReadings: READINGS }), ['root01', ROOTO + NO + '01'], ['root']);
});

test('keysOf: aliases, labels and tolerance for missing fields', () => {
  has(keysOf(foxhound), ['foxhound', HOUDI]);
  has(keysOf({ name: 'x-ray', label: 'Navigator' }), ['xray', 'ray', 'navigator'], ['x']);
  assert.deepEqual(keysOf({ name: 'solo' }), ['solo']);
  assert.deepEqual(keysOf({ name: 'solo' }, {}), ['solo']);
});

test('keysOf: session readings match the session name in any case; a numeric session gives no address keys', () => {
  has(keysOf(kennel, { sessionReadings: { Labs: [LABO] } }), [LABO + NO + '05']);
  assert.deepEqual(keysOf({ name: 'solo', address: at('0', 5) }), ['solo']);
});

// ---- findInvites ----

const LIVE = [kennel, e5, root01];
const INVITE_WORDS = ['invite', 'bring in', '\u547c\u3093\u3067']; // last: "call in" in Japanese
const invite = (text, extra = {}) => findInvites({ text, live: LIVE, inviteWords: INVITE_WORDS, sessionReadings: READINGS, ...extra });

test('findInvites: an invite word plus an exact reference names the live session', () => {
  assert.deepEqual(invite('please invite watchdog'), ['watchdog-kennel']);
  assert.deepEqual(invite('bring in 05'), ['watchdog-kennel']);
  assert.deepEqual(invite(LABO + NO + ZERO_GO + '\u3092\u547c\u3093\u3067'), ['watchdog-kennel']);
  assert.deepEqual(invite('invite watchdog and 04'), ['watchdog-kennel', 'zeta-labs-e5']);
});

test('findInvites: no invite word, a loose name, or a word inside another word invites nobody', () => {
  assert.deepEqual(invite('watchdog is great'), []);
  assert.deepEqual(invite('invite watchdo'), []);
  assert.deepEqual(invite('uninvited watchdog'), []);
  assert.deepEqual(invite('invite 2 people'), []);
});

test('findInvites: sessions already in the meeting are skipped; missing input is tolerated', () => {
  assert.deepEqual(invite('please invite watchdog', { participants: [kennel] }), []);
  assert.deepEqual(findInvites({ text: 'invite watchdog', live: [], inviteWords: ['invite'] }), []);
  assert.deepEqual(findInvites({ text: 'invite watchdog' }), []);
});

test('resolve: invite is filled only when live sessions and invite words are passed', () => {
  const people = [foxhound, hq];
  const asked = { participants: people, live: [kennel], inviteWords: ['invite'] };
  assert.deepEqual(ask('invite watchdog', asked), { to: ['foxhound'], maybe: [], focus: [], invite: ['watchdog-kennel'] });
  assert.deepEqual(ask('invite watchdog', { participants: people }).invite, []);
});

// ---- resolveBaton ----

const baton = (text, holders = [], extra = {}) =>
  resolveBaton({ text, participants: ALL, holders, chairName: 'foxhound', everyoneWords: ['everyone', 'all of you'], sessionReadings: READINGS, ...extra });

test('resolveBaton: names become the holders, several allowed', () => {
  assert.deepEqual(baton('HQ, how is it going?', ['foxhound']), { holders: ['Labs-HQ'], named: ['Labs-HQ'], maybe: [] });
  assert.deepEqual(baton('HQ and Labs-01, status?'), { holders: ['Labs-HQ', 'Labs-01'], named: ['Labs-HQ', 'Labs-01'], maybe: [] });
});

test('resolveBaton: no name keeps the holders, and holders who left drop out', () => {
  assert.deepEqual(baton('and when is it done?', ['Labs-HQ']), { holders: ['Labs-HQ'], named: [], maybe: [] });
  assert.deepEqual(baton('and then?', ['Labs-HQ', 'gone']).holders, ['Labs-HQ']);
});

test('resolveBaton: no holders goes to the chair', () => {
  assert.deepEqual(baton('what should we do?'), { holders: ['foxhound'], named: [], maybe: [] });
  assert.deepEqual(baton('what now?', ['gone']).holders, ['foxhound']);
  assert.deepEqual(baton('what now?', [], { chairName: 'nobody' }).holders, []);
});

test('resolveBaton: everyone words give the baton to all', () => {
  const names = ALL.map((p) => p.name);
  assert.deepEqual(baton('everyone, please listen', ['Labs-HQ']), { holders: names, named: names, maybe: [] });
});

test('resolveBaton: a loose reference only suggests, the holders stay', () => {
  assert.deepEqual(baton('watchd, status?', ['Labs-01']), { holders: ['Labs-01'], named: [], maybe: ['watchdog-kennel'] });
  assert.deepEqual(baton('watchd, status?').holders, ['foxhound']);
});
