// Tests for lib/roster.mjs. They use temp directories and a fake tmux runner: the real sessions directory and tmux are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Roster, isAlive, fnv1a, cleanTitle, parsePanes, publicParticipant, LIST_PANES_ARGS } from './roster.mjs';

// Real pids go through the real liveness check: this process is alive and no process has the largest pid
const ALIVE = process.pid;
const DEAD = 2 ** 31 - 1;
const STAR = '\u2733'; // the status glyph Claude Code puts before a pane title
const SPINNER = '\u2802'; // a spinner frame it uses while working

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetdown-roster-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function putSession(dir, file, fields) {
  const data = { pid: ALIVE, kind: 'interactive', name: 'x', tmux: 'labs:@0.%0', status: 'idle', startedAt: 1, ...fields };
  fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify(data));
}

// A tmux runner that returns canned list-panes rows (pane id, session, window index, pane index, title)
function fakeTmux(rows) {
  const run = (args) => {
    run.calls.push(args);
    if (run.fail) throw new Error('no server running');
    return run.rows.map((r) => r.join('\t')).join('\n') + '\n';
  };
  run.calls = [];
  run.rows = rows;
  run.fail = false;
  return run;
}

const panes = () => [
  ['%0', 'labs', '0', '0', 'Thanks for flying Vim'],
  ['%4', 'labs', '0', '1', `${STAR} Labs-01`],
  ['%1', 'labs', '0', '2', `${STAR} Labs-02`],
  ['%5', 'labs', '0', '3', `${STAR} Labs-03`],
  ['%2', 'labs', '0', '4', `${STAR} Labs-04`],
  ['%6', 'labs', '0', '5', `${STAR} watchdog-kennel`],
  ['%3', 'labs', '0', '6', ''],
  ['%43', 'foxhound-kennel', '0', '0', `${STAR} foxhound`],
  ['%44', 'foxhound-kennel', '1', '0', 'a-hostname.local'],
];

// Five live sessions shaped like a real machine: the e5 session sits in pane 4 and its title says Labs-04,
// and the HQ pane carries a leftover editor title
function world(t, options = {}) {
  const dir = tempDir(t);
  putSession(dir, 'hq', { name: 'Labs-HQ', tmux: 'labs:@0.%0', startedAt: 1 });
  putSession(dir, 'one', { name: 'Labs-01', tmux: 'labs:@0.%4', startedAt: 2 });
  putSession(dir, 'e5', { name: 'labs-e5', tmux: 'labs:@0.%2', status: 'busy', startedAt: 3 });
  putSession(dir, 'kennel', { name: 'watchdog-kennel', tmux: 'labs:@0.%6', status: 'shell', startedAt: 4 });
  putSession(dir, 'fox', { name: 'foxhound', tmux: 'foxhound-kennel:@21.%43', startedAt: 5 });
  const tmux = fakeTmux(panes());
  const roster = new Roster({ sessionsDir: dir, tmux, ...options });
  return { dir, tmux, roster };
}

const names = (list) => list.map((x) => x.name);
const collect = (roster) => {
  const events = [];
  roster.on('change', (e) => events.push(e));
  return events;
};

test('live() lists alive interactive sessions in tmux order, with address and title from one tmux call', (t) => {
  const { tmux, roster } = world(t);
  roster.poll();
  assert.deepEqual(roster.live().map((s) => [s.name, s.pane, s.address, s.title, s.status]), [
    ['foxhound', '%43', { session: 'foxhound-kennel', window: 0, pane: 0 }, 'foxhound', 'idle'],
    ['Labs-HQ', '%0', { session: 'labs', window: 0, pane: 0 }, '', 'idle'],
    ['Labs-01', '%4', { session: 'labs', window: 0, pane: 1 }, 'Labs-01', 'idle'],
    ['labs-e5', '%2', { session: 'labs', window: 0, pane: 4 }, 'Labs-04', 'busy'],
    ['watchdog-kennel', '%6', { session: 'labs', window: 0, pane: 5 }, 'watchdog-kennel', 'shell'],
  ]);
  assert.equal(tmux.calls.length, 1);
  assert.deepEqual(tmux.calls[0], [...LIST_PANES_ARGS]);
});

test('the tmux call is the one in the contract, with real tab separators', () => {
  assert.deepEqual([...LIST_PANES_ARGS], ['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_title}']);
  assert.ok(LIST_PANES_ARGS[3].includes('\t'));
});

test('sessions that do not count are left out, and the newest startedAt wins per name', (t) => {
  const { dir, roster } = world(t);
  putSession(dir, 'ghost', { name: 'ghost', pid: DEAD, tmux: 'labs:@0.%1', startedAt: 9 }); // the process is gone
  putSession(dir, 'bg', { name: 'Labs-01', kind: 'bg', tmux: undefined, startedAt: 99 }); // background session, same name, no tmux
  putSession(dir, 'bg2', { name: 'bg-with-tmux', kind: 'bg', tmux: 'labs:@0.%44', startedAt: 9 }); // not interactive, even with a tmux field
  putSession(dir, 'plain', { name: 'no-tmux', tmux: undefined, startedAt: 9 }); // not inside tmux
  putSession(dir, 'lost', { name: 'pane-missing', tmux: 'labs:@0.%99', startedAt: 9 }); // the pane is not in tmux
  putSession(dir, 'nameless', { name: '', tmux: 'labs:@0.%5', startedAt: 9 });
  putSession(dir, 'old', { name: 'Labs-01', tmux: 'labs:@0.%3', startedAt: 1 }); // older duplicate, sorts before the newer file
  putSession(dir, 'aaa', { name: 'Labs-02', tmux: 'labs:@0.%1', startedAt: 20 }); // newer duplicate, sorts before the older file
  putSession(dir, 'zzz', { name: 'Labs-02', tmux: 'labs:@0.%5', startedAt: 10 });
  fs.writeFileSync(path.join(dir, 'x.key'), 'not a session');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"pid":');
  fs.writeFileSync(path.join(dir, 'list.json'), '[1, 2]');
  roster.poll();
  const live = roster.live();
  assert.deepEqual(names(live).sort(), ['Labs-01', 'Labs-02', 'Labs-HQ', 'foxhound', 'labs-e5', 'watchdog-kennel']);
  assert.equal(live.find((s) => s.name === 'Labs-01').pane, '%4');
  assert.equal(live.find((s) => s.name === 'Labs-02').pane, '%1');
});

test('the pane id is the number after the last percent sign of the tmux field', (t) => {
  const { dir, roster } = world(t);
  putSession(dir, 'percent', { name: 'percent-session', tmux: '100%7:@0.%44', startedAt: 9 }); // a tmux session name may contain a percent sign
  putSession(dir, 'odd', { name: 'odd-session', tmux: 'labs:@0.4', startedAt: 9 }); // no pane id at all
  roster.poll();
  const live = roster.live();
  assert.deepEqual(live.find((s) => s.name === 'percent-session'), { name: 'percent-session', pane: '%44', address: { session: 'foxhound-kennel', window: 1, pane: 0 }, title: '', status: 'idle' });
  assert.ok(!names(live).includes('odd-session'));
});

test('a status that is missing counts as idle', (t) => {
  const { dir, roster } = world(t);
  putSession(dir, 'one', { name: 'Labs-01', tmux: 'labs:@0.%4', status: undefined, startedAt: 2 });
  roster.poll();
  assert.equal(roster.live().find((s) => s.name === 'Labs-01').status, 'idle');
});

test('cleanTitle strips the status glyph and drops titles that never had one', () => {
  assert.equal(cleanTitle(`${STAR} Labs-04`), 'Labs-04');
  assert.equal(cleanTitle(`${SPINNER} Labs-04`), 'Labs-04');
  assert.equal(cleanTitle(`  ${STAR}  \u00a0-- Labs-04  `), 'Labs-04');
  assert.equal(cleanTitle(`${STAR} 01 hq`), '01 hq'); // digits are kept
  assert.equal(cleanTitle(`${STAR} caf\u00e9`), 'caf\u00e9'); // letters of any script are kept
  assert.equal(cleanTitle(STAR), '');
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(undefined), '');
  assert.equal(cleanTitle('Thanks for flying Vim'), '');
  assert.equal(cleanTitle('a-hostname.local'), '');
});

test('parsePanes reads tab separated rows and skips what it cannot read', () => {
  const out = [
    `%4\tlabs\t0\t1\t${STAR} Labs-01`,
    '%3\tlabs\t0\t6\t',
    `%9\tweird session\t2\t3\t${STAR} a\tb`, // a tab inside the title stays in the title
    'garbage line',
    '%x\tlabs\t0\t1\ttitle',
    '%8\tlabs\tzero\t1\ttitle',
    '%7\tlabs\t0',
    '',
  ].join('\r\n');
  const parsed = parsePanes(out);
  assert.deepEqual([...parsed.keys()], ['%4', '%3', '%9']);
  assert.deepEqual(parsed.get('%4'), { address: { session: 'labs', window: 0, pane: 1 }, title: 'Labs-01' });
  assert.deepEqual(parsed.get('%3'), { address: { session: 'labs', window: 0, pane: 6 }, title: '' });
  assert.deepEqual(parsed.get('%9'), { address: { session: 'weird session', window: 2, pane: 3 }, title: 'a\tb' });
  assert.equal(parsePanes(undefined).size, 0);
});

test('a participant gets label, voice, taste and chair from the config, with defaults', (t) => {
  const pool = [{ voice: 'V0', style: 'S0' }, { voice: 'V1', style: 'S1' }, { voice: 'V2', style: 'S2' }];
  const people = { foxhound: { label: 'Chair', aliases: ['nick', '', 5], voice: 'Vf', style: 'Sf', taste: 'meet', look: { species: 'fox' } } };
  const { roster } = world(t, { people, voicePool: pool, defaultTaste: 'plain' });
  roster.poll();

  const fox = roster.join('foxhound');
  assert.deepEqual(publicParticipant(fox), {
    name: 'foxhound', pane: '%43', address: { session: 'foxhound-kennel', window: 0, pane: 0 }, title: 'foxhound', status: 'idle',
    label: 'Chair', aliases: ['nick'], voice: 'Vf', style: 'Sf', chair: true, taste: 'meet', look: { species: 'fox' },
  });
  assert.equal(fox.cursor, 0);
  assert.equal(fox.noticed, 0);

  const one = roster.join('Labs-01');
  const picked = pool[fnv1a('Labs-01') % pool.length];
  assert.deepEqual([one.label, one.voice, one.style, one.taste, one.chair, one.aliases, one.look], ['Labs-01', picked.voice, picked.style, 'plain', false, [], {}]);

  const hq = roster.join('Labs-HQ'); // its pane title is junk, so the title is empty and the label is the name
  assert.deepEqual([hq.title, hq.label], ['', 'Labs-HQ']);

  const e5 = roster.join('labs-e5'); // the title says Labs-04
  assert.deepEqual([e5.title, e5.label], ['Labs-04', 'Labs-04']);
});

test('the default taste is pixel when none is given', (t) => {
  const { roster } = world(t);
  roster.poll();
  assert.equal(roster.join('Labs-01').taste, 'pixel');
});

test('a name keeps its voice: the pool is indexed by a stable hash of the name', (t) => {
  const pool = [{ voice: 'V0', style: 'S0' }, { voice: 'V1', style: 'S1' }, { voice: 'V2', style: 'S2' }, { voice: 'V3', style: 'S3' }];
  const a = world(t, { voicePool: pool });
  const b = world(t, { voicePool: pool });
  a.roster.poll();
  b.roster.poll();
  for (const name of ['foxhound', 'Labs-01', 'labs-e5', 'Labs-HQ']) {
    const pa = a.roster.join(name);
    const pb = b.roster.join(name);
    assert.deepEqual({ voice: pa.voice, style: pa.style }, { voice: pb.voice, style: pb.style });
    assert.deepEqual({ voice: pa.voice, style: pa.style }, pool[fnv1a(name) % pool.length]);
  }
  const c = world(t, { people: { 'Labs-01': { voice: 'Vx' } } }); // a configured voice without a style, and no pool
  c.roster.poll();
  assert.deepEqual([c.roster.join('Labs-01').voice, c.roster.join('Labs-01').style], ['Vx', '']);
  assert.deepEqual([c.roster.join('labs-e5').voice, c.roster.join('labs-e5').style], ['', '']);
});

test('fnv1a matches the reference values and hashes UTF-8 bytes', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
  assert.equal(fnv1a('Labs-01'), 0x93e5bf6b);
  assert.equal(fnv1a('\u00e9'), 0x1e9de8c1);
});

test('the chair is the configured one, else the default chair', (t) => {
  const chairs = (options) => {
    const { roster } = world(t, options);
    roster.poll();
    return ['foxhound', 'Labs-HQ'].map((n) => roster.join(n).chair);
  };
  assert.deepEqual(chairs({}), [true, false]); // no flag anywhere: the session named foxhound
  assert.deepEqual(chairs({ people: { 'Labs-HQ': { chair: true } } }), [false, true]); // a flag elsewhere moves the chair
  assert.deepEqual(chairs({ people: { foxhound: { chair: false } } }), [false, false]); // an explicit false is respected
  assert.deepEqual(chairs({ defaultChair: 'Labs-HQ' }), [false, true]);
});

test('join, leave, byName and byPane', (t) => {
  const { roster } = world(t);
  roster.poll();
  assert.equal(roster.join('nobody'), null); // not live
  assert.equal(roster.byName('Labs-01'), null); // live, but did not join
  const e5 = roster.join('labs-e5');
  const one = roster.join('Labs-01');
  assert.equal(roster.join('Labs-01'), one); // joining twice returns the same participant
  assert.deepEqual(names(roster.participants()), ['labs-e5', 'Labs-01']); // join order
  assert.equal(roster.byName('labs-e5'), e5);
  assert.equal(roster.byPane('%4'), one);
  assert.equal(roster.byPane('%2'), e5);
  assert.equal(roster.byPane('%0'), null); // Labs-HQ did not join
  assert.equal(roster.byPane(''), null);
  assert.equal(roster.byPane(undefined), null);
  assert.equal(roster.leave('nobody'), false);
  assert.equal(roster.leave('labs-e5'), true);
  assert.deepEqual(names(roster.participants()), ['Labs-01']);
  assert.equal(roster.byName('labs-e5'), null);
  assert.equal(roster.live().length, 5); // leaving does not make the session less live
});

test('participants() gives the live objects, so cursor and noticed stay where the courier put them', (t) => {
  const { roster } = world(t);
  roster.poll();
  roster.join('Labs-01').cursor = 12;
  roster.participants()[0].noticed = 30;
  roster.poll();
  assert.deepEqual([roster.byName('Labs-01').cursor, roster.byName('Labs-01').noticed], [12, 30]);
});

test('a participant whose session disappears stays as absent, and returns in its new pane', (t) => {
  const { dir, roster } = world(t);
  roster.poll();
  const p = roster.join('Labs-01');
  putSession(dir, 'one', { name: 'Labs-01', pid: DEAD, tmux: 'labs:@0.%4', startedAt: 2 });
  roster.poll();
  assert.equal(roster.participants().length, 1);
  assert.equal(roster.byName('Labs-01'), p); // the same object
  assert.deepEqual([p.status, p.pane, p.title, p.label], ['absent', null, 'Labs-01', 'Labs-01']);
  assert.deepEqual(p.address, { session: 'labs', window: 0, pane: 1 }); // the last known place
  assert.equal(roster.byPane('%4'), null);
  assert.ok(!names(roster.live()).includes('Labs-01'));

  putSession(dir, 'again', { name: 'Labs-01', tmux: 'labs:@0.%5', startedAt: 7 }); // restarted in another pane
  roster.poll();
  assert.deepEqual([p.status, p.pane, p.title, p.label], ['idle', '%5', 'Labs-03', 'Labs-03']);
  assert.deepEqual(p.address, { session: 'labs', window: 0, pane: 3 });
  assert.equal(roster.byPane('%5'), p);
});

test('status follows the session file: idle, busy, shell', (t) => {
  const { dir, roster } = world(t);
  roster.poll();
  const p = roster.join('Labs-01');
  for (const status of ['busy', 'shell', 'idle']) {
    putSession(dir, 'one', { name: 'Labs-01', tmux: 'labs:@0.%4', status, startedAt: 2 });
    roster.poll();
    assert.equal(p.status, status);
  }
});

test("'change' is emitted only on real changes", (t) => {
  const { dir, roster } = world(t);
  const events = collect(roster);
  roster.poll();
  assert.deepEqual(events, [{ live: true, participants: false }]); // the first sight of the sessions
  roster.poll();
  roster.poll();
  assert.equal(events.length, 1); // nothing changed

  assert.equal(roster.join('nobody'), null);
  assert.equal(roster.leave('nobody'), false);
  assert.equal(events.length, 1); // failed joins and leaves are no change

  const p = roster.join('Labs-01');
  assert.deepEqual(events.at(-1), { live: false, participants: true });
  roster.join('Labs-01');
  assert.equal(events.length, 2); // joining twice is no change

  p.cursor = 5; // fields that only the server uses
  p.noticed = 7;
  roster.poll();
  assert.equal(events.length, 2);

  putSession(dir, 'one', { name: 'Labs-01', tmux: 'labs:@0.%4', status: 'busy', startedAt: 2 }); // a participant changes
  roster.poll();
  assert.deepEqual(events.at(-1), { live: true, participants: true });
  assert.equal(events.length, 3);

  putSession(dir, 'e5', { name: 'labs-e5', tmux: 'labs:@0.%2', status: 'idle', startedAt: 3 }); // a session that did not join changes
  roster.poll();
  assert.deepEqual(events.at(-1), { live: true, participants: false });
  assert.equal(events.length, 4);

  roster.leave('Labs-01');
  assert.deepEqual(events.at(-1), { live: false, participants: true });
  assert.equal(events.length, 5);
});

test('poll() says whether anything changed', (t) => {
  const { dir, roster } = world(t);
  assert.equal(roster.poll(), true);
  assert.equal(roster.poll(), false);
  putSession(dir, 'one', { name: 'Labs-01', tmux: 'labs:@0.%4', status: 'busy', startedAt: 2 });
  assert.equal(roster.poll(), true);
});

test('reset starts a new meeting: participants clear, then the autoJoin names join if live', (t) => {
  const { roster } = world(t);
  roster.poll();
  roster.join('Labs-01');
  roster.join('labs-e5');
  roster.byName('Labs-01').cursor = 12;
  const events = collect(roster);
  const joined = roster.reset(['foxhound', 'not-live']);
  assert.deepEqual(names(joined), ['foxhound']);
  assert.deepEqual(names(roster.participants()), ['foxhound']);
  assert.equal(roster.byName('Labs-01'), null);
  assert.deepEqual(events, [{ live: false, participants: true }]); // one event for the whole reset
  assert.equal(roster.join('Labs-01').cursor, 0); // a fresh participant
  roster.reset();
  assert.deepEqual(roster.participants(), []);
});

test('the first live(), join() or reset() polls when poll() has never run', (t) => {
  const a = world(t);
  assert.equal(a.roster.live().length, 5);
  assert.equal(a.tmux.calls.length, 1);
  assert.equal(a.roster.live().length, 5);
  assert.equal(a.tmux.calls.length, 1); // only the first call polls
  const b = world(t);
  assert.equal(b.roster.join('Labs-01').name, 'Labs-01');
  const c = world(t);
  assert.deepEqual(names(c.roster.reset(['foxhound'])), ['foxhound']);
});

test('a half-written session file keeps the last good copy instead of making the session blink', (t) => {
  const { dir, roster } = world(t);
  roster.poll();
  const events = collect(roster);
  fs.writeFileSync(path.join(dir, 'one.json'), '{"pid":12'); // caught while being written
  roster.poll();
  assert.ok(names(roster.live()).includes('Labs-01'));
  fs.writeFileSync(path.join(dir, 'one.json'), ''); // truncated, not yet written
  roster.poll();
  assert.ok(names(roster.live()).includes('Labs-01'));
  assert.equal(events.length, 0);
  fs.rmSync(path.join(dir, 'one.json')); // really gone
  roster.poll();
  assert.ok(!names(roster.live()).includes('Labs-01'));
  assert.equal(events.length, 1);
});

test('when tmux cannot be asked, a session in the same pane keeps its address and new sessions wait', (t) => {
  const { dir, tmux, roster } = world(t);
  roster.poll();
  const events = collect(roster);
  tmux.fail = true;
  putSession(dir, 'one', { name: 'Labs-01', tmux: 'labs:@0.%4', status: 'busy', startedAt: 2 }); // known session, new status
  putSession(dir, 'two', { name: 'Labs-02', tmux: 'labs:@0.%1', startedAt: 2 }); // unknown session
  putSession(dir, 'e5', { name: 'labs-e5', tmux: 'labs:@0.%5', status: 'busy', startedAt: 3 }); // known session, moved
  roster.poll();
  const live = roster.live();
  const one = live.find((s) => s.name === 'Labs-01');
  assert.deepEqual([one.status, one.address, one.title], ['busy', { session: 'labs', window: 0, pane: 1 }, 'Labs-01']);
  assert.ok(!names(live).includes('Labs-02'));
  assert.ok(!names(live).includes('labs-e5'));
  assert.equal(events.length, 1);

  tmux.fail = false;
  roster.poll();
  assert.ok(names(roster.live()).includes('Labs-02'));
  assert.equal(roster.live().find((s) => s.name === 'labs-e5').pane, '%5');
});

test('an answer from tmux with no readable pane counts as tmux being unavailable', (t) => {
  const { tmux, roster } = world(t);
  roster.poll();
  const events = collect(roster);
  for (const rows of [[['not', 'a', 'pane', 'row']], []]) {
    tmux.rows = rows;
    roster.poll();
    assert.equal(roster.live().length, 5); // nobody is dropped because tmux said something unreadable
  }
  assert.equal(events.length, 0);
});

test('a missing sessions directory means nobody is live, and tmux is not asked', (t) => {
  const dir = tempDir(t);
  const tmux = fakeTmux(panes());
  const roster = new Roster({ sessionsDir: path.join(dir, 'missing'), tmux });
  assert.doesNotThrow(() => roster.poll());
  assert.deepEqual(roster.live(), []);
  assert.equal(tmux.calls.length, 0);
});

test('sessionsDir is required', () => {
  assert.throws(() => new Roster({}), TypeError);
  assert.throws(() => new Roster(), TypeError);
});

test('what live() returns cannot be used to change the roster', (t) => {
  const { roster } = world(t);
  roster.poll();
  const first = roster.live();
  first[0].address.pane = 99;
  first[0].name = 'changed';
  first.pop();
  const again = roster.live();
  assert.equal(again.length, 5);
  assert.equal(again[0].name, 'foxhound');
  assert.equal(again[0].address.pane, 0);
});

test('publicParticipant leaves out the server-only fields and returns a copy', (t) => {
  const { roster } = world(t, { people: { foxhound: { look: { species: 'fox' } } } });
  roster.poll();
  const fox = roster.join('foxhound');
  fox.cursor = 4;
  const pub = publicParticipant(fox);
  assert.ok(!('cursor' in pub));
  assert.ok(!('noticed' in pub));
  pub.look.species = 'cat';
  pub.address.pane = 9;
  assert.equal(fox.look.species, 'fox');
  assert.equal(fox.address.pane, 0);
});

test('isAlive probes only real pids, and EPERM counts as alive', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(DEAD), false);
  let probed = 0;
  const kill = () => { probed++; };
  for (const bad of [0, -1, 1.5, NaN, '123', null, undefined]) assert.equal(isAlive(bad, kill), false);
  assert.equal(probed, 0); // kill(0) and kill(-1) would signal whole process groups
  assert.equal(isAlive(10, kill), true);
  assert.equal(probed, 1);
  const failing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(isAlive(10, failing('EPERM')), true);
  assert.equal(isAlive(10, failing('ESRCH')), false);
  assert.equal(isAlive(10, failing('EINVAL')), false);
});
