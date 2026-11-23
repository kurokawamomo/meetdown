import test from 'node:test';
import assert from 'node:assert/strict';
import { diagLines, MAX_EVENTS, MAX_LINE } from './audio-diag.mjs';

const NOW = new Date('2026-11-23T01:02:03.000Z');

test('audio-diag: one line per event, with the server time, page id and user agent added', () => {
  const lines = diagLines({ page: 'p1', ua: 'Safari', events: [{ event: 'unlock', seq: 1 }, { event: 'play-start', seq: 2 }] }, NOW);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { server: NOW.toISOString(), page: 'p1', ua: 'Safari', event: 'unlock', seq: 1 });
  assert.equal(JSON.parse(lines[1]).event, 'play-start');
});

test('audio-diag: the page cannot overwrite the server time, page id or user agent of its own lines', () => {
  const [l] = diagLines({ page: 'p1', ua: 'u', events: [{ event: 'x', server: 'fake', page: 'other', ua: 'other' }] }, NOW);
  const e = JSON.parse(l);
  assert.equal(e.server, NOW.toISOString());
  assert.equal(e.page, 'p1');
  assert.equal(e.ua, 'u');
});

test('audio-diag: junk is dropped, and a batch is cut to the limit', () => {
  assert.deepEqual(diagLines(null, NOW), []);
  assert.deepEqual(diagLines({ events: 'no' }, NOW), []);
  assert.equal(diagLines({ events: [null, 3, 'x', [1], { event: 'ok' }] }, NOW).length, 1);
  assert.equal(diagLines({ events: Array.from({ length: MAX_EVENTS + 50 }, () => ({ event: 'a' })) }, NOW).length, MAX_EVENTS);
});

test('audio-diag: an oversized event is dropped, not cut into broken JSON', () => {
  const lines = diagLines({ events: [{ event: 'big', blob: 'x'.repeat(MAX_LINE) }, { event: 'small' }] }, NOW);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'small');
});

test('audio-diag: long page ids and user agents are cut', () => {
  const [l] = diagLines({ page: 'p'.repeat(500), ua: 'u'.repeat(900), events: [{ event: 'x' }] }, NOW);
  const e = JSON.parse(l);
  assert.equal(e.page.length, 40);
  assert.equal(e.ua.length, 300);
});
