import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize } from './summary.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetdown-summary-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let serial = 0;
// A stand-in for the claude binary: a shell script with the given body
function fakeBin(body) {
  const file = path.join(dir, `claude-${++serial}`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

// A stand-in that records its arguments (NUL-separated) in a file, reads stdin to the end, then prints `output`
function recordingBin(output = '- ok') {
  const capture = path.join(dir, `args-${++serial}`);
  const bin = fakeBin(`for a in "$@"; do printf '%s\\0' "$a"; done > '${capture}'\ncat > /dev/null\necho '${output}'`);
  const args = () => fs.readFileSync(capture, 'utf8').split('\0').slice(0, -1);
  return { bin, capture, args };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = async (pid, withinMs) => {
  for (const start = Date.now(); Date.now() - start < withinMs;) {
    try { process.kill(pid, 0); } catch (_) { return true; }
    await sleep(25);
  }
  return false;
};

const LINES = [
  { label: 'Human', text: 'Shall we ship on Friday?', aside: false, kind: 'voice' },
  { label: 'Houdie', text: 'Yes, Friday works.', aside: false, kind: 'say' },
  { label: 'Labs-01', text: 'Quietly, I am worried about the tests.', aside: true, kind: 'say' },
  { label: 'Meeting', text: 'shared digest that repeats the remarks', aside: false, kind: 'share' },
  { label: 'Meeting', text: 'Labs-01 joined', aside: false, kind: 'join' },
  { label: 'Meeting', text: 'no voice reply', aside: false, kind: 'no_reply' },
  { label: 'Human', text: '   ', aside: false, kind: 'text' },
  { label: 'Human', text: 'Two\nlines', aside: false, kind: 'text' },
];

test('summarize: runs claude in print mode with Haiku and passes the transcript as the last argument', async () => {
  const { bin, args } = recordingBin('  - Decided: ship on Friday  \n');
  const text = await summarize({ meetingId: '2026-11-20-ab12', lines: LINES, claudeBin: bin, timeoutMs: 5000 });
  assert.equal(text, '- Decided: ship on Friday');
  const a = args();
  assert.deepEqual(a.slice(0, 4), ['-p', '--model', 'haiku', '--no-session-persistence']);
  assert.equal(a.length, 5);
  const prompt = a[4];
  assert.ok(prompt.includes('2026-11-20-ab12'));
  assert.ok(prompt.includes('3-6 bullet points'));
  assert.ok(prompt.includes('decisions'));
  assert.ok(prompt.includes('open questions'));
  assert.ok(prompt.includes('who does what'));
  assert.ok(prompt.includes('no preamble'));
  assert.ok(prompt.includes('language the meeting was held in'));
  const transcript = prompt.slice(prompt.indexOf('Transcript:\n') + 'Transcript:\n'.length);
  assert.equal(
    transcript,
    ['Human: Shall we ship on Friday?', 'Houdie: Yes, Friday works.', 'Labs-01 (aside): Quietly, I am worried about the tests.', 'Human: Two lines'].join('\n'),
  );
});

test('summarize: stdin is closed, so a program that reads it does not wait', async () => {
  const bin = fakeBin('cat > /dev/null\necho done');
  assert.equal(await summarize({ meetingId: 'm', lines: LINES, claudeBin: bin, timeoutMs: 5000 }), 'done');
});

test('summarize: a program that outlives the timeout gives null quickly and is stopped at once', async () => {
  const pidFile = path.join(dir, 'pid');
  const bin = fakeBin(`echo $$ > '${pidFile}'\nexec sleep 30`);
  const started = Date.now();
  assert.equal(await summarize({ meetingId: 'm', lines: LINES, claudeBin: bin, timeoutMs: 1000 }), null);
  assert.ok(Date.now() - started < 2500);
  assert.ok(await exited(Number(fs.readFileSync(pidFile, 'utf8')), 1000));
});

test('summarize: a program that ignores the polite stop is killed after a short grace period', async () => {
  const pidFile = path.join(dir, 'pid-stubborn');
  const bin = fakeBin(`echo $$ > '${pidFile}'\ntrap '' TERM\ni=0\nwhile [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done`);
  assert.equal(await summarize({ meetingId: 'm', lines: LINES, claudeBin: bin, timeoutMs: 1000 }), null);
  assert.ok(await exited(Number(fs.readFileSync(pidFile, 'utf8')), 4000));
});

test('summarize: a failing exit gives null even when something was printed', async () => {
  const bin = fakeBin('echo "partial output"\necho "boom" >&2\nexit 1');
  const logs = [];
  assert.equal(await summarize({ meetingId: 'm', lines: LINES, claudeBin: bin, timeoutMs: 5000, log: (...a) => logs.push(a.join(' ')) }), null);
  assert.ok(logs.some((l) => l.includes('code=1') && l.includes('boom')));
});

test('summarize: empty output gives null', async () => {
  const bin = fakeBin('echo "   "');
  assert.equal(await summarize({ meetingId: 'm', lines: LINES, claudeBin: bin, timeoutMs: 5000 }), null);
});

test('summarize: a missing program gives null instead of throwing', async () => {
  const logs = [];
  const missing = path.join(dir, 'no-such-claude');
  assert.equal(await summarize({ meetingId: 'm', lines: LINES, claudeBin: missing, timeoutMs: 5000, log: (...a) => logs.push(a.join(' ')) }), null);
  assert.equal(logs.length, 1);
});

test('summarize: a meeting with no speech does not start claude', async () => {
  const { bin, capture } = recordingBin();
  const quiet = [{ label: 'Meeting', text: 'digest', aside: false, kind: 'share' }, { label: 'Human', text: '', aside: false, kind: 'voice' }];
  assert.equal(await summarize({ meetingId: 'm', lines: quiet, claudeBin: bin, timeoutMs: 5000 }), null);
  assert.equal(await summarize({ meetingId: 'm', lines: [], claudeBin: bin, timeoutMs: 5000 }), null);
  assert.equal(fs.existsSync(capture), false);
});

test('summarize: lines without a kind count as speech', async () => {
  const { bin, args } = recordingBin();
  await summarize({ meetingId: 'm', lines: [{ label: 'Human', text: 'hello' }], claudeBin: bin, timeoutMs: 5000 });
  assert.ok(args()[4].endsWith('Transcript:\nHuman: hello'));
});

test('summarize: a very long meeting keeps the newest remarks within the size limit and says so', async () => {
  const { bin, args } = recordingBin();
  const lines = Array.from({ length: 3000 }, (_, i) => ({ label: 'Human', text: `line-${String(i).padStart(4, '0')} ${'x'.repeat(80)}`, aside: false, kind: 'voice' }));
  await summarize({ meetingId: 'm', lines, claudeBin: bin, timeoutMs: 5000 });
  const prompt = args()[4];
  assert.ok(Buffer.byteLength(prompt) < 125_000);
  assert.ok(prompt.includes('line-2999'));
  assert.ok(!prompt.includes('line-0000'));
  assert.match(prompt, /Transcript \(the first \d+ remarks are left out because the meeting was long\):/);
});

test('summarize: the size limit counts bytes, so multi-byte text is limited too, and one remark is clipped', async () => {
  const { bin, args } = recordingBin();
  const lines = Array.from({ length: 200 }, () => ({ label: 'Human', text: '\u3042'.repeat(2000), aside: false, kind: 'voice' }));
  await summarize({ meetingId: 'm', lines, claudeBin: bin, timeoutMs: 5000 });
  const prompt = args()[4];
  assert.ok(Buffer.byteLength(prompt) < 125_000);
  assert.ok(prompt.includes(`Human: ${'\u3042'.repeat(1000)}\u2026`));
  assert.ok(!prompt.includes('\u3042'.repeat(1001)));
});
