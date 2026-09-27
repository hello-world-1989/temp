import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSubPath, validTweetQuery, processTweetItem, mimeOf } from '../src/worker.js';

test('paths cannot leave the intended repo', () => {
  assert.equal(isSafeSubPath('tweet/image/a.jpg'), true);
  for (const bad of ['../x', 'a/../b', './a', 'a\\b', '', 'a/\u0000']) assert.equal(isSafeSubPath(bad), false, bad);
});

test('tweet query validation matches the old server', () => {
  assert.equal(validTweetQuery({ year: '2026', month: '09', day: '27' }, ['whyyoutouzhele']), true);
  assert.equal(validTweetQuery({ year: '2026', month: 'undefined' }, ['x']), true);
  assert.equal(validTweetQuery({ year: '26' }, []), false);
  assert.equal(validTweetQuery({ year: '2026' }, ['../x']), false);
});

test('tweet images and videos are merged', () => {
  assert.deepEqual(processTweetItem({ images: 'a,b', videos: 'c' }).allImages, ['a', 'b', 'c']);
  assert.deepEqual(processTweetItem({}).allImages, []);
});

test('content types by extension', () => {
  assert.equal(mimeOf('/index.html'), 'text/html; charset=utf-8');
  assert.equal(mimeOf('/x.apk'), 'application/vnd.android.package-archive');
  assert.equal(mimeOf('/x.unknown', 'image/jpeg'), 'image/jpeg');
});
