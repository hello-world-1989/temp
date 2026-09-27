import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSubPath, isToken } from '../src/worker.js';

test('file paths cannot leave the intended repo', () => {
  assert.equal(isSafeSubPath('android/android-nthlink.zip'), true);
  assert.equal(isSafeSubPath('tweet/image/a/2026/09/26/1_0.jpg'), true);
  for (const bad of ['../x', 'a/../../b', './a', 'a//b', 'a\\b', '', 'a/\u0000']) {
    assert.equal(isSafeSubPath(bad), false, bad);
  }
});

test('subscription tokens', () => {
  assert.equal(isToken('2db985f6-1234-4abc-8def-0123456789ab'), true);
  assert.equal(isToken('short'), false);
  assert.equal(isToken('abc&days=365'), false);
});
