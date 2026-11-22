import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createThoughts, latestActivity } from './thoughts.mjs';

const line = (obj) => JSON.stringify(obj);
const asst = (...content) => line({ type: 'assistant', message: { content } });
const tool = (name, input) => ({ type: 'tool_use', name, input });
const text = (t) => ({ type: 'text', text: t });

test('latestActivity: newest assistant text wins, tool calls are left out, text uses its first non-empty line', () => {
  assert.equal(latestActivity([asst(text('Looking.'), tool('Read', { file_path: '/p/a.js' })), line({ type: 'user' })]), 'Looking.');
  assert.equal(latestActivity([asst(tool('Read', { file_path: '/p/a.js' })), asst(text('\n\n  First line\nsecond'))]), 'First line');
  assert.equal(latestActivity([asst(text('Earlier')), asst(tool('Bash', { command: 'ls' })), 'not json {']), 'Earlier');
  assert.equal(latestActivity([line({ type: 'user' })]), '');
  assert.equal(latestActivity([asst(text('x'.repeat(100)))]).length, 60);
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thoughts-'));
  const sessionsDir = path.join(dir, 'sessions');
  const projectsDir = path.join(dir, 'projects');
  await fs.mkdir(sessionsDir);
  const cwd = '/Users/me/my.proj';
  const transcriptDir = path.join(projectsDir, '-Users-me-my-proj');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, '123.json'), JSON.stringify({ name: 'hq', sessionId: 'sid1', cwd, status: 'busy' }));
  const file = path.join(transcriptDir, 'sid1.jsonl');
  let clock = Date.now();
  const thoughts = createThoughts({ sessionsDir, projectsDir, intervalMs: 3600000, idleMs: 20000, now: () => clock });
  const events = [];
  thoughts.on('thought', (e) => events.push(e));
  return { dir, file, thoughts, events, advance: (ms) => { clock += ms; }, cleanup: () => { thoughts.stop(); return fs.rm(dir, { recursive: true, force: true }); } };
}

test('thoughts: emits on change only, then clears after 20 s idle', async () => {
  const s = await setup();
  try {
    await fs.writeFile(s.file, asst(text('Reading server.mjs'), tool('Read', { file_path: '/x/server.mjs' })) + '\n');
    s.thoughts.watch(['hq']);
    await s.thoughts.tick();
    await s.thoughts.tick();
    assert.deepEqual(s.events, [{ name: 'hq', text: 'Reading server.mjs' }]);

    await fs.appendFile(s.file, asst(text('All done.')) + '\n');
    await s.thoughts.tick();
    assert.deepEqual(s.events.at(-1), { name: 'hq', text: 'All done.' });

    s.advance(21000);
    await s.thoughts.tick();
    assert.deepEqual(s.events.at(-1), { name: 'hq', text: '' });
    await s.thoughts.tick();
    assert.equal(s.events.length, 3);
  } finally { await s.cleanup(); }
});

test('thoughts: reads only the tail of a large transcript and survives a cut first line', async () => {
  const s = await setup();
  try {
    const filler = asst(text('filler '.repeat(50))) + '\n';
    await fs.writeFile(s.file, filler.repeat(400) + asst(text('needle'), tool('Grep', { pattern: 'needle' })) + '\n');
    s.thoughts.watch(['hq']);
    await s.thoughts.tick();
    assert.deepEqual(s.events, [{ name: 'hq', text: 'needle' }]);
  } finally { await s.cleanup(); }
});

test('thoughts: unknown sessions, missing transcripts and unwatched names emit nothing and never throw', async () => {
  const s = await setup();
  try {
    s.thoughts.watch(['ghost', 'hq']);
    await s.thoughts.tick();
    assert.deepEqual(s.events, []);
    const broken = createThoughts({ sessionsDir: '/nonexistent/a', projectsDir: '/nonexistent/b' });
    broken.watch(['hq']);
    await broken.tick();
    broken.stop();
  } finally { await s.cleanup(); }
});
