import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFreeNodes, isSafeSubPath, isToken } from '../src/worker.js';

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

test('free nodes are parsed from the base64 subscription', () => {
  const lines = [
    'vless://u@1.2.3.4:443?security=reality#end-gfw-sgn1-VLESS',
    'hysteria2://u@1.2.3.4:443/?sni=x#end-gfw-sgn1-HY2',
    'ss://abc=@1.2.3.4:8443#%E5%85%8D%E8%B4%B9',
    'javascript:alert(1)',
    '',
  ];
  const nodes = parseFreeNodes(btoa(lines.join('\r\n')));
  assert.deepEqual(nodes.map((n) => n.protocol), ['VLESS', 'Hysteria2', 'Shadowsocks']);
  assert.equal(nodes[0].name, 'end-gfw-sgn1-VLESS');
  assert.equal(nodes[2].name, '免费');
  assert.deepEqual(parseFreeNodes('%%%not base64'), []);
});
