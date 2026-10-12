import test from 'node:test';
import assert from 'node:assert/strict';
import { viaMirror } from '../src/worker.js';

const req = (headers) => new Request('https://end-gfw.com/api/checkin/id?token=x', { headers });
const none = new Set();

test('main-site pages may check in', async () => {
  assert.equal(await viaMirror(req({ referer: 'https://end-gfw.com/checkin' }), {}, none), false);
  assert.equal(await viaMirror(req({ referer: 'https://www.end-gfw.com/my' }), {}, none), false);
  assert.equal(await viaMirror(req({}), {}, none), false);
});

test('pages on mirror addresses may not', async () => {
  assert.equal(await viaMirror(req({ referer: 'https://52.221.223.204/checkin' }), {}, none), true);
  assert.equal(await viaMirror(req({ origin: 'https://mirror.example.org' }), {}, none), true);
  assert.equal(await viaMirror(req({ referer: 'not a url' }), {}, none), true);
});

test('requests from a mirror server IP may not', async () => {
  const ips = new Set(['52.221.223.204']);
  assert.equal(await viaMirror(req({ 'cf-connecting-ip': '52.221.223.204' }), {}, ips), true);
  assert.equal(await viaMirror(req({ 'cf-connecting-ip': '1.2.3.4' }), {}, ips), false);
});
