import test from 'node:test';
import assert from 'node:assert/strict';
import { crossSite } from './cross-site.mjs';

test('a POST from another site is refused', () => {
  assert.equal(crossSite({ method: 'POST', host: '127.0.0.1:7790', origin: 'https://evil.example', fetchSite: 'cross-site' }), true);
  assert.equal(crossSite({ method: 'POST', host: '127.0.0.1:7790', origin: 'https://evil.example' }), true);
  assert.equal(crossSite({ method: 'POST', host: '127.0.0.1:7790', origin: 'null' }), true);
});

test("the page's own requests, GETs and meet-say pass", () => {
  assert.equal(crossSite({ method: 'POST', host: '127.0.0.1:7790', origin: 'http://127.0.0.1:7790', fetchSite: 'same-origin' }), false);
  assert.equal(crossSite({ method: 'POST', host: 'mac.tail.ts.net:17790', origin: 'https://mac.tail.ts.net:17790' }), false);
  assert.equal(crossSite({ method: 'GET', host: '127.0.0.1:7790', fetchSite: 'cross-site' }), false);
  assert.equal(crossSite({ method: 'POST', host: '127.0.0.1:7790' }), false);
});
