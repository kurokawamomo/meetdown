// Tests for lib/meeting.mjs. They use temp directories and a fake clock: no real waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Meeting, DEFAULT_GRACE_MS, STATES } from './meeting.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetdown-meeting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Local time 2026-11-20 09:30:00. Timers fire only when advance() passes them.
function clock() {
  const c = { time: new Date(2026, 10, 20, 9, 30, 0).getTime(), start: 0, seq: 0, timers: new Map(), delays: [] };
  c.start = c.time;
  c.now = () => new Date(c.time);
  c.setTimer = (fn, ms) => {
    const id = ++c.seq;
    c.timers.set(id, { fn, at: c.time + ms });
    c.delays.push(ms);
    return id;
  };
  c.clearTimer = (id) => c.timers.delete(id);
  c.advance = (ms) => {
    c.time += ms;
    for (const [id, timer] of [...c.timers]) {
      if (timer.at <= c.time && c.timers.has(id)) {
        c.timers.delete(id);
        timer.fn();
      }
    }
  };
  return c;
}

function setup(t, options = {}) {
  const dir = tempDir(t);
  const clk = clock();
  const meeting = new Meeting({ dir, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, randomSuffix: () => 'ab12', ...options });
  return { dir, clk, meeting };
}

const iso = (ms) => new Date(ms).toISOString();
const readRows = (meeting) => fs.readFileSync(meeting.paths.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const plain = (x) => JSON.parse(JSON.stringify(x));

// Rebuilds the utterances from log lines: an update line changes the utterance with that id
function replay(rows) {
  const byId = new Map();
  const out = [];
  for (const row of rows) {
    if ('update' in row) {
      const { update, at, ...fields } = row;
      Object.assign(byId.get(update), fields);
    } else {
      byId.set(row.id, row);
      out.push(row);
    }
  }
  return out;
}

test('a meeting has an id of the local date and four hex digits, starts open, and creates its directory', (t) => {
  const dir = path.join(tempDir(t), 'nested', 'meetings');
  const clk = clock();
  const meeting = new Meeting({ dir, now: clk.now });
  assert.match(meeting.id, /^2026-11-20-[0-9a-f]{4}$/);
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(meeting.info(), { id: meeting.id, state: 'open', startedAt: iso(clk.start), deadline: null });
  assert.equal(meeting.state, 'open');
  assert.deepEqual(meeting.list, []);
  assert.deepEqual(meeting.paths, { log: path.join(dir, `${meeting.id}.jsonl`), summary: path.join(dir, `${meeting.id}.summary.md`) });
  assert.deepEqual(fs.readdirSync(dir), []); // nothing is written until the first utterance
  assert.throws(() => new Meeting({}), TypeError);
  assert.throws(() => new Meeting(), TypeError);
});

test('the date in the id is the local date, early and late in the day', (t) => {
  for (const [hour, minute] of [[0, 30], [23, 30]]) {
    const meeting = new Meeting({ dir: tempDir(t), now: () => new Date(2026, 10, 20, hour, minute, 0) });
    assert.match(meeting.id, /^2026-11-20-/);
  }
});

test('an id that is taken is skipped', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, '2026-11-20-aaaa.jsonl'), '');
  fs.writeFileSync(path.join(dir, '2026-11-20-bbbb.summary.md'), '');
  const suffixes = ['aaaa', 'bbbb', 'cccc'];
  const meeting = new Meeting({ dir, now: clock().now, randomSuffix: () => suffixes.shift() });
  assert.equal(meeting.id, '2026-11-20-cccc');
  assert.throws(() => new Meeting({ dir, now: clock().now, randomSuffix: () => 'aaaa' }), /no free meeting id/);
});

test('append gives ids and times, fills empty fields, writes a log line and announces the utterance', (t) => {
  const { clk, meeting } = setup(t);
  const heard = [];
  meeting.on('utterance', (u) => heard.push(u));
  const first = { kind: 'voice', from: 'human', to: ['Labs-01'], text: 'hello' };
  const returned = meeting.append(first);
  clk.advance(1500);
  const second = meeting.append({ kind: 'join', from: 'system' });

  assert.equal(returned, first); // the same object is stored and returned
  assert.deepEqual([first.id, second.id], [1, 2]);
  assert.equal(first.at, iso(clk.start));
  assert.deepEqual(second, { id: 2, at: iso(clk.start + 1500), kind: 'join', from: 'system', to: [], maybe: [], aside: false, text: '' });
  assert.deepEqual(heard, [first, second]);
  assert.deepEqual(meeting.list, [first, second]);

  const file = fs.readFileSync(meeting.paths.log, 'utf8');
  assert.ok(file.endsWith('\n'));
  const rows = readRows(meeting);
  assert.deepEqual(rows, plain([first, second]));
  assert.deepEqual(Object.keys(rows[0]).slice(0, 2), ['id', 'at']); // readable lines: id and time first
  assert.throws(() => meeting.append(null), TypeError);
  assert.throws(() => meeting.append('text'), TypeError);
});

test('update changes the utterance, writes an update line and announces it again', (t) => {
  const { clk, meeting } = setup(t);
  const u = meeting.append({ kind: 'say', from: 'Labs-01', text: 'one. two.', play: 'queued' });
  const heard = [];
  meeting.on('utterance', (x) => heard.push([x.id, x.play, x.cutAt]));
  clk.advance(2000);

  assert.equal(meeting.update(u, { play: 'cut', cutAt: 1, id: 99, at: 'x', update: 5, skipped: undefined }), u);
  assert.deepEqual([u.id, u.play, u.cutAt, 'skipped' in u], [1, 'cut', 1, false]); // identity and time are never changed
  assert.equal(meeting.update(1, { play: 'done' }), u); // by id
  assert.deepEqual(heard, [[1, 'cut', 1], [1, 'done', 1]]);
  assert.deepEqual(readRows(meeting).slice(1), [
    { update: 1, at: iso(clk.start + 2000), play: 'cut', cutAt: 1 },
    { update: 1, at: iso(clk.start + 2000), play: 'done' },
  ]);

  assert.equal(meeting.update(u, {}), u); // nothing to change: nothing is written or announced
  assert.equal(meeting.update(u), u);
  assert.equal(meeting.update(u, { id: 5 }), u);
  assert.equal(readRows(meeting).length, 3);
  assert.equal(heard.length, 2);
});

test("update ignores utterances that are not this meeting's", (t) => {
  const { meeting } = setup(t);
  const earlier = setup(t).meeting; // a late event may still hold an utterance of an earlier meeting
  const foreign = earlier.append({ kind: 'say', from: 'a', text: 'x', play: 'queued' });
  meeting.append({ kind: 'say', from: 'b', text: 'y', play: 'queued' });
  assert.equal(foreign.id, 1); // the same id as the utterance in this meeting
  assert.equal(meeting.update(foreign, { play: 'done' }), null);
  assert.equal(meeting.list[0].play, 'queued');
  assert.equal(meeting.update(42, { play: 'done' }), null);
  assert.equal(meeting.update(null, { play: 'done' }), null);
  assert.equal(meeting.update('1', { play: 'done' }), null);
  assert.equal(readRows(meeting).length, 1);
});

test('the log replays to the same utterances', (t) => {
  const { clk, meeting } = setup(t);
  const a = meeting.append({ kind: 'voice', from: 'human', to: ['x'], text: 'hi' });
  const b = meeting.append({ kind: 'say', from: 'x', text: 's', play: 'queued' });
  clk.advance(100);
  meeting.update(b, { play: 'playing' });
  meeting.update(b, { play: 'cut', cutAt: 0 });
  meeting.update(a, { text: 'hi there' });
  assert.deepEqual(replay(readRows(meeting)), plain(meeting.list));
});

test('leave sets leaving with a deadline, and expire follows when the grace ends', (t) => {
  const { clk, meeting } = setup(t);
  const states = [];
  meeting.on('state', (i) => states.push([i.state, i.deadline]));
  const expired = [];
  meeting.on('expire', (i) => expired.push(i.state));

  assert.equal(meeting.leave(10_000), true);
  const deadline = iso(clk.start + 10_000);
  assert.deepEqual(meeting.info(), { id: meeting.id, state: 'leaving', startedAt: iso(clk.start), deadline });
  assert.deepEqual(clk.delays, [10_000]);
  clk.advance(9_999);
  assert.deepEqual(expired, []);
  assert.equal(meeting.state, 'leaving');

  clk.advance(1);
  assert.deepEqual(expired, ['leaving']); // listeners run first and start the summary
  assert.deepEqual(meeting.info(), { id: meeting.id, state: 'closing', startedAt: iso(clk.start), deadline: null });
  assert.deepEqual(states, [['leaving', deadline], ['closing', null]]);
  assert.equal(clk.timers.size, 0);
});

test('back during the grace cancels leaving, and no expire follows', (t) => {
  const { clk, meeting } = setup(t);
  const expired = [];
  meeting.on('expire', () => expired.push(1));
  const states = [];
  meeting.on('state', (i) => states.push(i.state));

  meeting.leave(10_000);
  clk.advance(4_000);
  assert.equal(meeting.back(), true);
  assert.deepEqual(meeting.info(), { id: meeting.id, state: 'open', startedAt: iso(clk.start), deadline: null });
  assert.equal(clk.timers.size, 0); // the timer was cleared
  clk.advance(60_000);
  assert.deepEqual(expired, []);
  assert.equal(meeting.back(), false); // nothing left to cancel

  assert.equal(meeting.leave(5_000), true); // leaving works again after back
  clk.advance(5_000);
  assert.deepEqual(expired, [1]);
  assert.equal(meeting.back(), false); // too late: closing has started
  assert.deepEqual(states, ['leaving', 'open', 'leaving', 'closing']);
});

test('leave twice keeps the first deadline and one timer, and is ignored once closing or closed', (t) => {
  const { clk, meeting } = setup(t);
  meeting.leave(10_000);
  const deadline = meeting.info().deadline;
  clk.advance(3_000);
  assert.equal(meeting.leave(10_000), false);
  assert.equal(meeting.info().deadline, deadline);
  assert.equal(clk.timers.size, 1);
  assert.deepEqual(clk.delays, [10_000]);

  clk.advance(7_000);
  assert.equal(meeting.state, 'closing');
  assert.equal(meeting.leave(), false);
  meeting.close('x');
  assert.equal(meeting.leave(), false);
  assert.equal(meeting.state, 'closed');
});

test('leave uses 10 seconds without an argument, and a bad grace falls back to it', (t) => {
  const { clk, meeting } = setup(t);
  assert.equal(DEFAULT_GRACE_MS, 10_000);
  for (const grace of [undefined, NaN, -5, 'soon']) {
    meeting.leave(grace);
    meeting.back();
  }
  assert.deepEqual(clk.delays, [10_000, 10_000, 10_000, 10_000]);
  meeting.leave(0); // a zero grace is valid
  assert.deepEqual(clk.delays.at(-1), 0);
});

test('a listener that moves the meeting on itself gets no second closing event', (t) => {
  const { clk, meeting } = setup(t);
  const states = [];
  meeting.on('state', (i) => states.push(i.state));
  meeting.on('expire', () => meeting.setState('closing'));
  meeting.leave();
  clk.advance(DEFAULT_GRACE_MS);
  assert.deepEqual(states, ['leaving', 'closing']);
  assert.equal(meeting.state, 'closing');
});

test('a listener that closes the meeting at once is respected', (t) => {
  const { clk, meeting } = setup(t);
  const states = [];
  meeting.on('state', (i) => states.push(i.state));
  meeting.on('expire', () => meeting.close('done'));
  meeting.leave();
  clk.advance(DEFAULT_GRACE_MS);
  assert.deepEqual(states, ['leaving', 'closed']);
});

test('a failing listener does not break the timer, it is logged', (t) => {
  const logged = [];
  const { clk, meeting } = setup(t, { log: (...a) => logged.push(a.join(' ')) });
  meeting.on('expire', () => { throw new Error('boom'); });
  meeting.on('state', (i) => { if (i.state === 'closing') throw new Error('bang'); });
  meeting.leave();
  assert.doesNotThrow(() => clk.advance(DEFAULT_GRACE_MS));
  assert.equal(meeting.state, 'closing');
  assert.equal(logged.length, 2);
  assert.match(logged[0], /expire listener failed: boom/);
  assert.match(logged[1], /state listener failed: bang/);
});

test('with the default timers, expire arrives after the grace and back cancels it', async (t) => {
  const dir = tempDir(t);
  const meeting = new Meeting({ dir });
  const expired = once(meeting, 'expire');
  meeting.leave(20);
  const [info] = await expired;
  assert.equal(info.id, meeting.id);
  assert.equal(meeting.state, 'closing');

  const other = new Meeting({ dir });
  let fired = false;
  other.on('expire', () => { fired = true; });
  other.leave(20);
  other.back();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, false);
  assert.equal(other.state, 'open');
});

test('setState checks the name, announces only real changes, and closed is final', (t) => {
  const { meeting } = setup(t);
  const states = [];
  meeting.on('state', (i) => states.push(i.state));
  assert.deepEqual(STATES, ['open', 'leaving', 'closing', 'closed']);
  assert.throws(() => meeting.setState('paused'), RangeError);
  assert.equal(meeting.setState('open'), false); // already open
  assert.equal(meeting.setState('closing'), true);
  assert.equal(meeting.setState('closing'), false);
  assert.equal(meeting.setState('closed'), true);
  assert.equal(meeting.setState('open'), false);
  assert.equal(meeting.setState('leaving'), false);
  assert.deepEqual(states, ['closing', 'closed']);
});

test('setState away from leaving stops the timer, and setState leaving is leave with the default grace', (t) => {
  const { clk, meeting } = setup(t);
  const expired = [];
  meeting.on('expire', () => expired.push(1));
  meeting.leave(10_000);
  assert.equal(meeting.setState('open'), true);
  assert.equal(clk.timers.size, 0);
  assert.equal(meeting.info().deadline, null);
  clk.advance(60_000);
  assert.deepEqual(expired, []);

  assert.equal(meeting.setState('leaving'), true);
  assert.deepEqual(clk.delays, [10_000, DEFAULT_GRACE_MS]);
  assert.equal(meeting.info().deadline, iso(clk.time + DEFAULT_GRACE_MS));
});

test('close writes the summary file with the summary and one plain line per utterance, and closes', (t) => {
  const labels = { human: 'Owner', 'labs-e5': 'Labs-04' };
  const { clk, meeting } = setup(t, { labelOf: (name) => labels[name] ?? name });
  const states = [];
  meeting.on('state', (i) => states.push(i.state));
  meeting.append({ kind: 'voice', from: 'human', to: ['labs-e5'], text: 'how is it going?' });
  clk.advance(5_000);
  meeting.append({ kind: 'say', from: 'labs-e5', text: 'Fine.\nAlmost  done.' });
  clk.advance(5_000);
  meeting.append({ kind: 'text', from: 'human', to: ['Labs-01'], aside: true, text: 'just you' });
  clk.advance(5_000);
  meeting.append({ kind: 'share', from: 'system', to: ['Labs-01', 'labs-e5'], text: 'Since you last heard: ...' });
  meeting.append({ kind: 'join', from: 'system', text: 'Labs-02 joined' });
  meeting.append({ kind: 'summary', from: 'system', to: ['labs-e5'], text: 'Decided X.' });
  meeting.append({ kind: 'no_reply', from: 'system' });
  meeting.setState('closing');
  clk.advance(1_000);

  const file = meeting.close('  Decided X.\n\nNext: Y.  ');
  assert.equal(file, meeting.paths.summary);
  assert.equal(path.basename(file), `${meeting.id}.summary.md`);
  assert.equal(fs.readFileSync(file, 'utf8'), [
    '# Meeting 2026-11-20-ab12',
    '',
    `- Started: ${iso(clk.start)}`,
    `- Ended: ${iso(clk.start + 16_000)}`,
    '- Utterances: 6',
    '',
    '## Summary',
    '',
    'Decided X.\n\nNext: Y.',
    '',
    '## Utterances',
    '',
    '- 09:30:00 Owner -> Labs-04: how is it going?',
    '- 09:30:05 Labs-04: Fine. Almost done.',
    '- 09:30:10 Owner -> Labs-01 (aside): just you',
    '- 09:30:15 [share] system -> Labs-01, Labs-04: Since you last heard: ...',
    '- 09:30:15 [join] system: Labs-02 joined',
    '- 09:30:15 [no_reply] system:',
    '',
  ].join('\n'));
  assert.equal(meeting.state, 'closed');
  assert.deepEqual(meeting.info(), { id: meeting.id, state: 'closed', startedAt: iso(clk.start), deadline: null });
  assert.deepEqual(states, ['closing', 'closed']);
});

test('close works from open, tolerates no summary and no utterances, and a second call changes nothing', (t) => {
  const { meeting } = setup(t);
  const states = [];
  meeting.on('state', (i) => states.push(i.state));
  const file = meeting.close(null);
  assert.equal(meeting.state, 'closed');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('_No summary was produced._'));
  assert.ok(text.includes('_No utterances._'));
  assert.ok(text.includes('- Utterances: 0'));

  const late = meeting.append({ kind: 'note', from: 'system', text: 'late' }); // the log accepts utterances after close
  assert.equal(late.id, 1);
  assert.equal(readRows(meeting).length, 1);
  assert.equal(meeting.close('another'), file);
  assert.equal(fs.readFileSync(file, 'utf8'), text); // not rewritten
  assert.deepEqual(states, ['closed']);

  assert.ok(fs.readFileSync(setup(t).meeting.close(undefined), 'utf8').includes('_No summary was produced._'));
  assert.ok(fs.readFileSync(setup(t).meeting.close('   '), 'utf8').includes('_No summary was produced._'));
});

test('close from leaving stops the timer', (t) => {
  const { clk, meeting } = setup(t);
  const expired = [];
  meeting.on('expire', () => expired.push(1));
  meeting.leave();
  meeting.close('bye');
  assert.equal(clk.timers.size, 0);
  clk.advance(60_000);
  assert.deepEqual(expired, []);
  assert.equal(meeting.state, 'closed');
});

test('close after setState closed still writes the file', (t) => {
  const { meeting } = setup(t);
  meeting.setState('closed');
  const file = meeting.close('late summary');
  assert.ok(fs.readFileSync(file, 'utf8').includes('late summary'));
});

test('a label function that fails falls back to the names', (t) => {
  const { meeting } = setup(t, { labelOf: () => { throw new Error('no label'); } });
  meeting.append({ kind: 'voice', from: 'human', to: ['x'], text: 'hi' });
  const text = fs.readFileSync(meeting.close('s'), 'utf8');
  assert.ok(text.includes('human -> x: hi'));
});

test('a log that cannot be written is reported, and the meeting goes on in memory', (t) => {
  const logged = [];
  const { meeting } = setup(t, { log: (...a) => logged.push(a.join(' ')) });
  fs.mkdirSync(meeting.paths.log); // a directory where the file should be
  const heard = [];
  meeting.on('utterance', (u) => heard.push(u.id));
  const u = meeting.append({ kind: 'text', from: 'human', text: 'hi' });
  assert.equal(u.id, 1);
  assert.deepEqual(heard, [1]);
  assert.deepEqual(meeting.list, [u]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /log write failed/);
  meeting.update(u, { play: 'done' });
  assert.equal(logged.length, 2);
  assert.deepEqual(heard, [1, 1]);
});

test('a summary that cannot be written returns null, the meeting still closes, and a second close retries', (t) => {
  const logged = [];
  const { meeting } = setup(t, { log: (...a) => logged.push(a.join(' ')) });
  fs.mkdirSync(meeting.paths.summary);
  assert.equal(meeting.close('x'), null);
  assert.equal(meeting.state, 'closed');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /summary write failed/);
  fs.rmdirSync(meeting.paths.summary);
  assert.equal(meeting.close('x'), meeting.paths.summary);
  assert.ok(fs.existsSync(meeting.paths.summary));
});
