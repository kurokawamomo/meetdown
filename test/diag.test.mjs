import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiag } from '../page/diag.js';

function rig(extra = {}) {
  const sent = [];
  const timers = [];
  let t = Date.parse('2026-11-23T00:00:00Z');
  const diag = createDiag({
    env: {
      now: () => t,
      page: 'pg1',
      ua: 'TestUA',
      hidden: () => false,
      send: async (body) => { sent.push(body); return true; },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      ...extra,
    },
  });
  return { diag, sent, timers, at: (ms) => { t += ms; } };
}

test('diag: events are queued and go out in one batch with the page id and user agent', async () => {
  const r = rig();
  r.diag.log('ctx-create', { ctx: { state: 'suspended', currentTime: 0 } });
  r.at(500);
  r.diag.log('unlock', { gesture: true });
  assert.equal(r.sent.length, 0);
  await r.diag.flush();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].page, 'pg1');
  assert.equal(r.sent[0].ua, 'TestUA');
  const [a, b] = r.sent[0].events;
  assert.deepEqual([a.event, a.seq, a.since, a.hidden], ['ctx-create', 1, 0, false]);
  assert.deepEqual([b.event, b.seq, b.since], ['unlock', 2, 500]);
  assert.equal(a.at, '2026-11-23T00:00:00.000Z');
});

test('diag: a run of identical events becomes one line with a count; moving currentTime does not make it different', async () => {
  const r = rig();
  r.diag.log('unlock', { gesture: true, ctx: { state: 'running', currentTime: 1 } });
  r.at(100);
  r.diag.log('unlock', { gesture: true, ctx: { state: 'running', currentTime: 2 } });
  r.at(100);
  r.diag.log('unlock', { gesture: true, ctx: { state: 'running', currentTime: 3 } });
  r.diag.log('unlock', { gesture: false, ctx: { state: 'running', currentTime: 3 } });
  r.diag.log('unlock', { gesture: true, ctx: { state: 'running', currentTime: 3 } });
  await r.diag.flush();
  const ev = r.sent[0].events;
  assert.equal(ev.length, 3);
  assert.equal(ev[0].n, 3);
  assert.equal(ev[0].lastAt, '2026-11-23T00:00:00.200Z');
  assert.equal(ev[1].n, undefined);
});

test('diag: a state change is not folded into the previous event', async () => {
  const r = rig();
  r.diag.log('ctx-state', { ctx: { state: 'running' } });
  r.diag.log('ctx-state', { ctx: { state: 'suspended' } });
  await r.diag.flush();
  assert.equal(r.sent[0].events.length, 2);
});

test('diag: a flush is scheduled by the first event, not one timer per event', () => {
  const r = rig();
  r.diag.log('a'); r.diag.log('b'); r.diag.log('c');
  assert.equal(r.timers.length, 1);
});

test('diag: hiding the tab sends at once', async () => {
  const r = rig();
  r.diag.log('visibility', { hidden: true });
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(r.sent.length, 1);
});

test('diag: a failed send keeps the events for the next batch, and a throwing send is swallowed', async () => {
  let fail = true;
  const r = rig({ send: async (body) => { if (fail) throw new Error('down'); r2.push(body); return true; } });
  const r2 = [];
  r.diag.log('a');
  await r.diag.flush();
  assert.equal(r2.length, 0);
  fail = false;
  await r.diag.flush();
  assert.equal(r2.length, 1);
  assert.equal(r2[0].events[0].event, 'a');
});

test('diag: log never throws, even with data that cannot be serialized', () => {
  const r = rig();
  const loop = {}; loop.me = loop;
  assert.doesNotThrow(() => r.diag.log('x', loop));
});

test('diag: more than one batch worth goes out in pieces of 60', async () => {
  const r = rig();
  for (let i = 0; i < 130; i++) r.diag.log('e' + i);
  await new Promise((ok) => setTimeout(ok, 20));
  await r.diag.flush();
  await r.diag.flush();
  assert.deepEqual(r.sent.map((b) => b.events.length), [60, 60, 10]);
});
