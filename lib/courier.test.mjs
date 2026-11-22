import test from 'node:test';
import assert from 'node:assert/strict';
import { createCourier } from './courier.mjs';

const SAY = '~/meetdown/bin/meet-say';
const MEETING = '2026-11-20-ab12';
const tail = (label) => `(meeting ${MEETING}; you are ${label}. Reply by running ${SAY} "what to say": spoken style, 1-3 sentences, in the language of the message. Text-only replies are not heard in the meeting.)`;
const ASIDE = 'This is an aside for you only; the others will see it later in the minutes.';
const shareTail = (label) => `(meeting ${MEETING}; you are ${label}. No reply needed. Only if you have something important to add, say one sentence with ${SAY} "...".)`;

let paneSerial = 0;
const person = (name, label, extra = {}) => ({ name, label, pane: `%${++paneSerial}`, cursor: 0, noticed: 0, ...extra });
const utt = (id, extra = {}) => ({ id, at: '', kind: 'voice', from: 'human', to: [], maybe: [], aside: false, text: `words ${id}`, ...extra });
const say = (id, from, extra = {}) => utt(id, { kind: 'say', from, play: 'done', text: `reply ${id}`, ...extra });

function setup({ people, list = [], sendResult = () => true } = {}) {
  const sent = [];
  const logs = [];
  const fails = [];
  const roster = { byName: (n) => people.find((p) => p.name === n) || null, participants: () => people };
  const meeting = { list, info: () => ({ id: MEETING, state: 'open', startedAt: '', deadline: null }) };
  const courier = createCourier({
    send: async (pane, text, opts) => {
      sent.push({ pane, text, opts });
      return sendResult(pane, text, opts);
    },
    sayPath: SAY,
    owner: 'Owner',
    log: (...a) => logs.push(a.join(' ')),
    onFail: (f) => fails.push(f),
  });
  return { courier, roster, meeting, sent, logs, fails };
}

test('deliver: header, reply instructions and pane; no digest when nothing is new', async () => {
  const hq = person('hq', 'HQ');
  const u1 = utt(1, { text: 'How is it going?', to: ['hq'] });
  const { courier, roster, meeting, sent } = setup({ people: [hq], list: [u1] });
  assert.deepEqual(await courier.deliver(meeting, roster, u1, ['hq']), ['hq']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, hq.pane);
  assert.equal(sent[0].text, `[meetdown Owner (voice)] How is it going? ${tail('HQ')}`);
  assert.equal(sent[0].opts.tag, 'u1');
});

test('deliver: typed text is labelled text, and a multi-line text becomes one line', async () => {
  const hq = person('hq', 'HQ');
  const u1 = utt(1, { kind: 'text', text: 'line one\nline two\r\n\r\nline three' });
  const { courier, roster, meeting, sent } = setup({ people: [hq], list: [u1] });
  await courier.deliver(meeting, roster, u1, ['hq']);
  assert.equal(sent[0].text, `[meetdown Owner (text)] line one line two line three ${tail('HQ')}`);
});

test('deliver: digest holds what is newer than the cursor, without own remarks, the current utterance, later ones or non-speech kinds', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const long = '\u3042'.repeat(100);
  const list = [
    utt(1, { text: 'First thing' }),
    say(2, 'lab', { text: 'Second thing' }),
    say(3, 'hq', { text: 'my own words' }),
    utt(4, { kind: 'share', from: 'system', text: 'shared digest' }),
    utt(5, { kind: 'note', from: 'system', text: 'a note' }),
    utt(6, { kind: 'text', text: long }),
    utt(7, { text: 'Current words' }),
    say(8, 'lab', { text: 'later' }),
  ];
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab], list });
  await courier.deliver(meeting, roster, list[6], ['hq']);
  assert.equal(
    sent[0].text,
    `[meetdown Owner (voice)] Current words / Since you last heard: Owner: "First thing" Labs-01: "Second thing" Owner: "${'\u3042'.repeat(80)}\u2026" ${tail('HQ')}`,
  );
  assert.equal(hq.cursor, 7);
  assert.equal(hq.noticed, 8);

  list.push(utt(9, { text: 'Next words' }));
  await courier.deliver(meeting, roster, list[8], ['hq']);
  assert.equal(sent[1].text, `[meetdown Owner (voice)] Next words / Since you last heard: Labs-01: "later" ${tail('HQ')}`);
  assert.equal(hq.cursor, 9);
});

test('deliver: digest is limited to the newest 10', async () => {
  const hq = person('hq', 'HQ');
  const list = Array.from({ length: 15 }, (_, i) => say(i + 1, 'lab', { text: `remark ${i + 1}` }));
  list.push(utt(16, { text: 'Now' }));
  const { courier, roster, meeting, sent } = setup({ people: [hq, person('lab', 'Labs-01')], list });
  await courier.deliver(meeting, roster, list[15], ['hq']);
  const expected = Array.from({ length: 10 }, (_, i) => `Labs-01: "remark ${i + 6}"`).join(' ');
  assert.equal(sent[0].text, `[meetdown Owner (voice)] Now / Since you last heard: ${expected} ${tail('HQ')}`);
});

test('deliver: clipping counts code points, so an emoji is never cut in half', async () => {
  const hq = person('hq', 'HQ');
  const emoji = '\u{1F600}';
  const list = [utt(1, { text: emoji.repeat(81) }), utt(2)];
  const { courier, roster, meeting, sent } = setup({ people: [hq], list });
  await courier.deliver(meeting, roster, list[1], ['hq']);
  assert.ok(sent[0].text.includes(`Owner: "${emoji.repeat(80)}\u2026"`));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(sent[0].text));
});

test('deliver: an aside is marked in the header and explained after the reply instructions', async () => {
  const hq = person('hq', 'HQ');
  const u1 = utt(1, { kind: 'text', aside: true, text: 'Just between us' });
  const { courier, roster, meeting, sent } = setup({ people: [hq], list: [u1] });
  await courier.deliver(meeting, roster, u1, ['hq']);
  assert.equal(sent[0].text, `[meetdown Owner (text, aside)] Just between us ${tail('HQ')} ${ASIDE}`);
});

test('deliver: an utterance that is not from the owner is attributed to its speaker', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const list = [say(1, 'lab', { text: 'Over to you' })];
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab], list });
  await courier.deliver(meeting, roster, list[0], ['hq']);
  assert.equal(sent[0].text, `[meetdown Labs-01 (text)] Over to you ${tail('HQ')}`);
});

test('deliver: reports where the previous remark was cut off, once', async () => {
  const hq = person('hq', 'HQ');
  const list = [utt(1, { text: 'Question' }), say(2, 'hq', { play: 'cut', cutAt: 2 }), utt(3, { text: 'Go on' })];
  const { courier, roster, meeting, sent } = setup({ people: [hq], list });
  await courier.deliver(meeting, roster, list[2], ['hq']);
  assert.equal(
    sent[0].text,
    `[meetdown Owner (voice)] Go on / Since you last heard: Owner: "Question" / Your previous remark was cut off during sentence 3. ${tail('HQ')}`,
  );
  list.push(utt(4, { text: 'Again' }));
  await courier.deliver(meeting, roster, list[3], ['hq']);
  assert.ok(!sent[1].text.includes('previous remark'));
});

test('deliver: the first sentence is sentence 1, a dropped remark was not played, the latest one wins', async () => {
  const first = person('first', 'First');
  const dropped = person('dropped', 'Dropped');
  const both = person('both', 'Both');
  const list = [
    say(1, 'first', { play: 'cut', cutAt: 0 }),
    say(2, 'dropped', { play: 'dropped' }),
    say(3, 'both', { play: 'cut', cutAt: 1 }),
    say(4, 'both', { play: 'dropped' }),
    say(5, 'first', { play: 'done' }),
    utt(6),
  ];
  const { courier, roster, meeting, sent } = setup({ people: [first, dropped, both], list });
  await courier.deliver(meeting, roster, list[5], ['first', 'dropped', 'both']);
  const note = (name) => sent.find((s) => s.pane === roster.byName(name).pane).text;
  assert.ok(note('first').includes(' / Your previous remark was cut off during sentence 1. '));
  assert.ok(note('dropped').includes(' / Your previous remark was not played. '));
  assert.ok(note('both').includes(' / Your previous remark was not played. '));
  assert.ok(!note('both').includes('cut off'));
});

test('deliver: another participant\'s cut remark and a remark with no voice error are not reported', async () => {
  const hq = person('hq', 'HQ');
  const list = [say(1, 'lab', { play: 'cut', cutAt: 0 }), say(2, 'hq', { play: 'error' }), utt(3)];
  const { courier, roster, meeting, sent } = setup({ people: [hq, person('lab', 'Labs-01')], list });
  await courier.deliver(meeting, roster, list[2], ['hq']);
  assert.ok(!sent[0].text.includes('previous remark'));
});

test('deliver: each participant gets their own digest, and the names are returned in order', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const list = [say(1, 'lab', { text: 'from lab' }), say(2, 'hq', { text: 'from hq' }), utt(3, { text: 'Everyone' })];
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab], list });
  assert.deepEqual(await courier.deliver(meeting, roster, list[2], ['lab', 'hq']), ['lab', 'hq']);
  const to = (p) => sent.find((s) => s.pane === p.pane).text;
  assert.ok(to(hq).includes('Since you last heard: Labs-01: "from lab" '));
  assert.ok(!to(hq).includes('from hq'));
  assert.ok(to(lab).includes('Since you last heard: HQ: "from hq" '));
  assert.ok(!to(lab).includes('from lab'));
});

test('deliver: a name listed twice is sent once', async () => {
  const hq = person('hq', 'HQ');
  const { courier, roster, meeting, sent } = setup({ people: [hq], list: [utt(1)] });
  assert.deepEqual(await courier.deliver(meeting, roster, meeting.list[0], ['hq', 'hq']), ['hq']);
  assert.equal(sent.length, 1);
});

test('deliver: panes are written in parallel', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab], list: [utt(1)], sendResult: () => gate.then(() => true) });
  const done = courier.deliver(meeting, roster, meeting.list[0], ['hq', 'lab']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  release();
  assert.deepEqual(await done, ['hq', 'lab']);
});

test('deliver: two quick messages to one participant do not repeat each other', async () => {
  const hq = person('hq', 'HQ');
  const list = [utt(1, { text: 'one' }), utt(2, { text: 'two' })];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { courier, roster, meeting, sent } = setup({ people: [hq], list, sendResult: () => gate.then(() => true) });
  const first = courier.deliver(meeting, roster, list[0], ['hq']);
  const second = courier.deliver(meeting, roster, list[1], ['hq']);
  release();
  await Promise.all([first, second]);
  assert.equal(sent[1].text, `[meetdown Owner (voice)] two ${tail('HQ')}`);
});

test('deliver: a message the pane did not take is not counted, and the next one carries what was missed', async () => {
  const hq = person('hq', 'HQ');
  let takes = false;
  const list = [say(1, 'hq', { play: 'cut', cutAt: 0 }), utt(2, { text: 'lost' })];
  const { courier, roster, meeting, sent, fails } = setup({ people: [hq], list, sendResult: () => takes });
  assert.deepEqual(await courier.deliver(meeting, roster, list[1], ['hq']), []);
  assert.equal(hq.cursor, 0);
  assert.equal(hq.noticed, 0);
  assert.deepEqual(fails, [{ kind: 'deliver', name: 'hq', label: 'HQ', why: 'not-delivered' }]);

  takes = true;
  list.push(utt(3, { text: 'found' }));
  assert.deepEqual(await courier.deliver(meeting, roster, list[2], ['hq']), ['hq']);
  assert.equal(
    sent[1].text,
    `[meetdown Owner (voice)] found / Since you last heard: Owner: "lost" / Your previous remark was cut off during sentence 1. ${tail('HQ')}`,
  );
  assert.equal(hq.cursor, 3);
});

test('deliver: the reason a pane gave up is passed to onFail', async () => {
  const hq = person('hq', 'HQ');
  const { courier, roster, meeting, fails } = setup({
    people: [hq],
    list: [utt(1)],
    sendResult: (pane, text, opts) => { opts.onGiveup('prompt-stayed'); return false; },
  });
  assert.deepEqual(await courier.deliver(meeting, roster, meeting.list[0], ['hq']), []);
  assert.equal(fails[0].why, 'prompt-stayed');
});

test('deliver: a send that throws or rejects is logged and skipped without stopping the others', async () => {
  const bad = person('bad', 'Bad');
  const worse = person('worse', 'Worse');
  const good = person('good', 'Good');
  const { courier, roster, meeting, fails, logs } = setup({
    people: [bad, worse, good],
    list: [utt(1)],
    sendResult: (pane) => {
      if (pane === bad.pane) throw new Error('tmux is gone');
      if (pane === worse.pane) return Promise.reject(new Error('paste failed'));
      return true;
    },
  });
  assert.deepEqual(await courier.deliver(meeting, roster, meeting.list[0], ['bad', 'worse', 'good']), ['good']);
  assert.deepEqual(fails.map((f) => f.name), ['bad', 'worse']);
  assert.ok(fails[0].why.includes('tmux is gone'));
  assert.ok(logs.some((l) => l.includes('paste failed')));
  assert.equal(bad.cursor, 0);
});

test('deliver: a missing pane or a name outside the meeting is logged and left out', async () => {
  const nopane = person('nopane', 'No Pane', { pane: null });
  const good = person('good', 'Good');
  const { courier, roster, meeting, sent, fails, logs } = setup({ people: [nopane, good], list: [utt(1)] });
  assert.deepEqual(await courier.deliver(meeting, roster, meeting.list[0], ['nopane', 'ghost', 'good']), ['good']);
  assert.equal(sent.length, 1);
  assert.deepEqual(fails.map((f) => [f.name, f.why]), [['nopane', 'no-pane'], ['ghost', 'not-in-meeting']]);
  assert.ok(logs.some((l) => l.includes('ghost')));
  assert.equal(nopane.cursor, 0);
});

test('deliver: log lines of the transport are passed on with a pane prefix', async () => {
  const hq = person('hq', 'HQ');
  const { courier, roster, meeting, logs } = setup({
    people: [hq],
    list: [utt(1)],
    sendResult: (pane, text, opts) => { opts.log('delivered', opts.tag); return true; },
  });
  await courier.deliver(meeting, roster, meeting.list[0], ['hq']);
  assert.ok(logs.includes('pane delivered u1'));
});

test('share: gives each participant what is new, skips those with nothing new, and moves only the cursor', async () => {
  const hq = person('hq', 'HQ', { noticed: 1 });
  const lab = person('lab', 'Labs-01');
  const list = [
    utt(1, { text: 'a' }),
    say(2, 'lab', { text: 'b', play: 'cut', cutAt: 0 }),
    utt(3, { kind: 'text', aside: true, text: 'c' }),
    utt(4, { kind: 'share', from: 'system', text: 'not part of a digest' }),
  ];
  lab.cursor = 3;
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab], list });
  assert.deepEqual(await courier.share(meeting, roster, ['hq', 'lab']), ['hq']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, hq.pane);
  assert.equal(sent[0].text, `[meetdown share] Since you last heard: Owner: "a" Labs-01: "b" Owner: "c" ${shareTail('HQ')}`);
  assert.equal(hq.cursor, 4);
  assert.equal(hq.noticed, 1);
  assert.equal(lab.cursor, 3);

  assert.deepEqual(await courier.share(meeting, roster, ['hq', 'lab']), []);
  assert.equal(sent.length, 1);
});

test('share: a participant who wrote everything new is skipped, and a failed share keeps the cursor', async () => {
  const hq = person('hq', 'HQ');
  const list = [say(1, 'hq', { text: 'mine' })];
  let takes = false;
  const { courier, roster, meeting, fails } = setup({ people: [hq, person('lab', 'Labs-01')], list, sendResult: () => takes });
  assert.deepEqual(await courier.share(meeting, roster, ['hq']), []);
  assert.deepEqual(fails, []);

  list.push(utt(2, { text: 'new' }));
  assert.deepEqual(await courier.share(meeting, roster, ['hq']), []);
  assert.equal(hq.cursor, 0);
  assert.equal(fails[0].kind, 'share');

  takes = true;
  assert.deepEqual(await courier.share(meeting, roster, ['hq']), ['hq']);
  assert.equal(hq.cursor, 2);
});

test('share: a name outside the meeting is left out without an error', async () => {
  const hq = person('hq', 'HQ');
  const { courier, roster, meeting } = setup({ people: [hq], list: [utt(1)] });
  assert.deepEqual(await courier.share(meeting, roster, ['ghost', 'hq']), ['hq']);
});

test('greet: names the others and explains how messages and replies look', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const wd = person('wd', 'Watchdog');
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab, wd] });
  assert.equal(await courier.greet(meeting, roster, wd), true);
  assert.equal(sent[0].pane, wd.pane);
  assert.equal(
    sent[0].text,
    `[meetdown] You joined meeting ${MEETING} as Watchdog. Others: HQ, Labs-01. Messages for you start with [meetdown ...]; reply with ${SAY} "...". If the baton reaches you by a word meant for someone else, run ${SAY} --route <word> <name> (add --once for this meeting only). No reply needed now.`,
  );
});

test('greet: says so when nobody else is in the meeting, and reports a missing pane', async () => {
  const alone = person('alone', 'Alone');
  const gone = person('gone', 'Gone', { pane: null });
  const { courier, roster, meeting, sent, fails } = setup({ people: [alone, gone] });
  await courier.greet(meeting, { ...roster, participants: () => [alone] }, alone);
  assert.ok(sent[0].text.includes(' Others: none. '));
  assert.equal(await courier.greet(meeting, roster, gone), false);
  assert.deepEqual(fails.map((f) => [f.kind, f.name, f.why]), [['greet', 'gone', 'no-pane']]);
});

test('dismiss: tells the participant to stop using meet-say', async () => {
  const hq = person('hq', 'HQ');
  const { courier, meeting, sent } = setup({ people: [hq] });
  assert.equal(await courier.dismiss(meeting, hq), true);
  assert.equal(sent[0].pane, hq.pane);
  assert.equal(sent[0].text, `[meetdown] You left meeting ${MEETING}. No reply needed. Do not run meet-say for this meeting anymore.`);
});

test('summary: goes to every participant as one line and asks for no reply', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const gone = person('gone', 'Gone', { pane: null });
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab, gone] });
  const names = await courier.summary(meeting, roster, '- Ship on Friday\n- Open: who owns the docs\r\n- Labs-01 writes tests\n');
  assert.deepEqual(names, ['hq', 'lab']);
  assert.equal(sent.length, 2);
  assert.equal(
    sent[0].text,
    `[meetdown summary] Meeting ${MEETING} ended. - Ship on Friday - Open: who owns the docs - Labs-01 writes tests (No reply needed. Do not run meet-say.)`,
  );
});

test('summary: without text the participants still learn that the meeting ended', async () => {
  const hq = person('hq', 'HQ');
  const { courier, roster, meeting, sent } = setup({ people: [hq] });
  assert.deepEqual(await courier.summary(meeting, roster, '  '), ['hq']);
  assert.equal(sent[0].text, `[meetdown summary] Meeting ${MEETING} ended. (No reply needed. Do not run meet-say.)`);
});

test('createCourier: refuses a missing transport and defaults the optional settings', async () => {
  assert.throws(() => createCourier({}), TypeError);
  const sent = [];
  const courier = createCourier({ send: async (pane, text) => { sent.push(text); return true; } });
  const hq = person('hq', 'HQ');
  const roster = { byName: () => hq, participants: () => [hq] };
  const meeting = { list: [utt(1)], info: () => ({ id: MEETING }) };
  await courier.deliver(meeting, roster, meeting.list[0], ['hq']);
  assert.ok(sent[0].startsWith('[meetdown the user (voice)] words 1 (meeting'));
  assert.ok(sent[0].includes('Reply by running meet-say "what to say"'));
});

test('never throws: a broken meeting or roster, or a missing participant, gives an empty result', async () => {
  const hq = person('hq', 'HQ');
  const { courier, roster, meeting, sent, logs } = setup({ people: [hq], list: [utt(1)] });
  const noInfo = { list: meeting.list, info: () => { throw new Error('no meeting'); } };
  const noRoster = { byName: () => { throw new Error('no roster'); }, participants: () => { throw new Error('no roster'); } };
  assert.deepEqual(await courier.deliver(noInfo, roster, meeting.list[0], ['hq']), []);
  assert.deepEqual(await courier.share(noInfo, roster, ['hq']), []);
  assert.equal(await courier.dismiss(noInfo, hq), false);
  assert.equal(await courier.greet(meeting, roster, null), false);
  assert.deepEqual(await courier.deliver(meeting, noRoster, meeting.list[0], ['hq']), []);
  assert.deepEqual(await courier.summary(meeting, noRoster, 'text'), []);
  assert.equal(sent.length, 0);
  assert.equal(logs.length, 6);
});

// ---- v3: everyone hears everything; the baton decides who answers ----

const HOLD = (label) => `(meeting ${MEETING}; you are ${label}. You hold the baton: answer by running ${SAY} "what to say" (spoken style, 1-3 sentences, in the language of the message), or pass it with ${SAY} --pass <name> "why". Text-only replies are not heard in the meeting.)`;
const LISTEN = (label) => `(meeting ${MEETING}; you are ${label}. You do not hold the baton: listen only; if you have nothing important, do nothing (no reply needed). If you must speak, run ${SAY} --murmur "..." or ask for the baton in a murmur.)`;

test('broadcast: everyone gets it; holders are told to answer or pass, the others to listen only', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const wd = person('wd', 'Watchdog');
  const u = utt(1, { text: 'HQ, status?' });
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab, wd], list: [u] });
  assert.deepEqual(await courier.broadcast(meeting, roster, u, ['hq']), ['hq', 'lab', 'wd']);
  const to = (p) => sent.find((s) => s.pane === p.pane);
  assert.equal(to(hq).text, `[meetdown Owner (voice; baton: HQ)] HQ, status? ${HOLD('HQ')}`);
  assert.equal(to(lab).text, `[meetdown Owner (voice; baton: HQ)] HQ, status? ${LISTEN('Labs-01')}`);
  assert.equal(to(wd).text, `[meetdown Owner (voice; baton: HQ)] HQ, status? ${LISTEN('Watchdog')}`);
  assert.equal(to(hq).opts.tag, 'u1');
});

test('broadcast: several holders are listed, no digest is added, typed text is labelled text', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const list = [utt(1, { text: 'old' }), say(2, 'lab', { text: 'older' }), utt(3, { kind: 'text', text: 'a\nb' })];
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab], list });
  await courier.broadcast(meeting, roster, list[2], ['hq', 'lab']);
  assert.equal(sent[0].text, `[meetdown Owner (text; baton: HQ, Labs-01)] a b ${HOLD('HQ')}`);
  assert.ok(!sent[0].text.includes('Since you last heard'));
});

test('broadcast: nobody holding the baton reads "none"; the speaking participant and absent ones are skipped', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const away = person('away', 'Away', { status: 'absent' });
  const u = say(4, 'lab', { text: 'my view' });
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab, away], list: [u] });
  assert.deepEqual(await courier.broadcast(meeting, roster, u, []), ['hq']);
  assert.equal(sent[0].text, `[meetdown Labs-01 (text; baton: none)] my view ${LISTEN('HQ')}`);
});

test('broadcast: reports a cut-off remark once and moves the read position; a failed pane is left out', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const list = [say(1, 'hq', { play: 'cut', cutAt: 0 }), utt(2, { text: 'Go on' })];
  const { courier, roster, meeting, sent, fails } = setup({ people: [hq, lab], list, sendResult: (pane) => pane !== lab.pane });
  assert.deepEqual(await courier.broadcast(meeting, roster, list[1], ['hq']), ['hq']);
  assert.equal(sent[0].text, `[meetdown Owner (voice; baton: HQ)] Go on / Your previous remark was cut off during sentence 1. ${HOLD('HQ')}`);
  assert.equal(hq.cursor, 2);
  assert.equal(lab.cursor, 0);
  assert.deepEqual(fails.map((f) => [f.kind, f.name]), [['broadcast', 'lab']]);
  await courier.broadcast(meeting, roster, list[1], ['hq']);
  assert.ok(!sent[2].text.includes('previous remark'));
});

test('interim: goes to everyone with a do-not-answer instruction and moves no read position', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab], list: [utt(1)] });
  assert.deepEqual(await courier.interim(meeting, roster, 'so the plan\nis', 3), ['hq', 'lab']);
  assert.equal(
    sent[0].text,
    `[meetdown Owner (still talking)] so the plan is (meeting ${MEETING}; you are HQ. Owner is still talking: do not answer yet; murmur with ${SAY} --murmur "..." only if important.)`,
  );
  assert.equal(sent[0].opts.tag, 'i3');
  assert.equal(hq.cursor, 0);
});

test('passed: only the receivers are told, with the giver and the reason', async () => {
  const hq = person('hq', 'HQ');
  const lab = person('lab', 'Labs-01');
  const wd = person('wd', 'Watchdog');
  const { courier, roster, meeting, sent } = setup({ people: [hq, lab, wd] });
  assert.deepEqual(await courier.passed(meeting, roster, 'hq', 'lab', 'Please check the tests'), ['lab']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, lab.pane);
  assert.equal(
    sent[0].text,
    `[meetdown HQ (passed the baton to you)] Please check the tests (meeting ${MEETING}; you are Labs-01. You hold the baton now: answer by running ${SAY} "what to say" (spoken style, 1-3 sentences), or pass it on with ${SAY} --pass <name> "why".)`,
  );
  assert.deepEqual(await courier.passed(meeting, roster, 'hq', ['lab', 'ghost', 'wd'], 'x'), ['lab', 'wd']);
});

test('broadcast, interim and passed never throw', async () => {
  const hq = person('hq', 'HQ');
  const { courier, roster, meeting } = setup({ people: [hq], list: [utt(1)] });
  const noInfo = { list: [], info: () => { throw new Error('no meeting'); } };
  const noRoster = { byName: () => { throw new Error('x'); }, participants: () => { throw new Error('x'); } };
  assert.deepEqual(await courier.broadcast(noInfo, roster, utt(1), ['hq']), []);
  assert.deepEqual(await courier.broadcast(meeting, noRoster, utt(1), ['hq']), []);
  assert.deepEqual(await courier.interim(meeting, noRoster, 'x', 1), []);
  assert.deepEqual(await courier.passed(noInfo, roster, 'hq', 'hq', 'x'), []);
});
