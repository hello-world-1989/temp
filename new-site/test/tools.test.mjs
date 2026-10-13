import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64decode, b64encode, splitInput, parseLink, parseAll, toClash, toBase64Sub, looksLikeText,
} from '../public/assets/tools-convert.js';

const UUID = '7e68e32f-8015-4f37-9082-70e8b0b58043';
const VLESS = `vless://${UUID}@1.2.3.4:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.bing.com&fp=chrome&pbk=PUBKEY_abc-123&sid=a1b2&type=tcp#%E6%96%B0%E5%8A%A0%E5%9D%A1%20VLESS`;
const SS = `ss://${Buffer.from('chacha20-ietf-poly1305:pass:word').toString('base64url')}@5.6.7.8:8443#SS%20node`;
const SS_LEGACY = `ss://${Buffer.from('aes-256-gcm:pw@9.9.9.9:8388').toString('base64')}#old`;
const SS_2022 = 'ss://2022-blake3-aes-256-gcm:a2V5%3D@1.1.1.1:443#ss2022';
const HY2 = 'hysteria2://p%40ss@1.2.3.4:443?sni=example.com&insecure=1&pinSHA256=AB:CD:EF#hy2';
const HY2_HOP = 'hy2://secret@[2001:db8::1]:443,20000-30000/?obfs=salamander&obfs-password=x#hop';
const TROJAN = 'trojan://pw@t.example.com:443?sni=t.example.com&type=ws&path=%2Fws&host=t.example.com#trojan';
const VMESS = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: '东京', add: 'v.example.com', port: '443', id: UUID, aid: '0', net: 'ws', path: '/v', host: 'v.example.com', tls: 'tls', sni: 'v.example.com' })).toString('base64');

test('base64 round trip with UTF-8, URL-safe and missing padding', () => {
  const s = '中文 test ✓';
  assert.equal(b64decode(b64encode(s)), s);
  assert.equal(b64decode(b64encode(s, true)), s);
  assert.equal(b64decode('aGk'), 'hi');
  assert.equal(b64decode('aG\nk='), 'hi');
  assert.throws(() => b64decode('not base64!'));
  assert.ok(looksLikeText('hello'));
});

test('vless reality link → clash proxy', () => {
  const n = parseLink(VLESS);
  assert.equal(n.name, '新加坡 VLESS');
  assert.equal(n.type, 'vless');
  assert.equal(n.server, '1.2.3.4');
  assert.equal(n.port, 443);
  assert.equal(n.uuid, UUID);
  assert.equal(n.tls, true);
  assert.equal(n.flow, 'xtls-rprx-vision');
  assert.equal(n.servername, 'www.bing.com');
  assert.deepEqual(n['reality-opts'], { 'public-key': 'PUBKEY_abc-123', 'short-id': 'a1b2' });
  assert.equal(n.encryption, undefined);
});

test('shadowsocks SIP002, legacy and SS-2022', () => {
  const a = parseLink(SS);
  assert.deepEqual([a.cipher, a.password, a.server, a.port, a.name], ['chacha20-ietf-poly1305', 'pass:word', '5.6.7.8', 8443, 'SS node']);
  const b = parseLink(SS_LEGACY);
  assert.deepEqual([b.cipher, b.password, b.server, b.port], ['aes-256-gcm', 'pw', '9.9.9.9', 8388]);
  const c = parseLink(SS_2022);
  assert.deepEqual([c.cipher, c.password], ['2022-blake3-aes-256-gcm', 'a2V5=']);
});

test('hysteria2: password, pin, port hopping, IPv6', () => {
  const a = parseLink(HY2);
  assert.equal(a.password, 'p@ss');
  assert.equal(a.fingerprint, 'abcdef');
  assert.equal(a['skip-cert-verify'], true);
  const b = parseLink(HY2_HOP);
  assert.equal(b.server, '2001:db8::1');
  assert.equal(b.port, 443);
  assert.equal(b.ports, '443,20000-30000');
  assert.equal(b.obfs, 'salamander');
});

test('trojan ws and vmess', () => {
  const t = parseLink(TROJAN);
  assert.equal(t.network, 'ws');
  assert.deepEqual(t['ws-opts'], { path: '/ws', headers: { Host: 't.example.com' } });
  const v = parseLink(VMESS);
  assert.equal(v.name, '东京');
  assert.equal(v.tls, true);
  assert.equal(v['ws-opts'].path, '/v');
});

test('base64 subscription body is decoded; bad lines are skipped; names deduplicated', () => {
  const body = Buffer.from([VLESS, SS, 'garbage://x', VLESS].join('\n')).toString('base64');
  const lines = splitInput(body);
  assert.equal(lines.length, 4);
  const { nodes, errors } = parseAll(lines);
  assert.equal(nodes.length, 3);
  assert.equal(errors.length, 1);
  assert.equal(new Set(nodes.map((n) => n.name)).size, 3);
  assert.throws(() => splitInput('proxies:\n  - name: a'), /Clash/);
  assert.throws(() => splitInput('https://sub.example.com/sub?token=x'), /订阅链接/);
});

test('clash yaml output', () => {
  const { nodes } = parseAll([VLESS, SS, HY2, TROJAN, VMESS]);
  const yaml = toClash(nodes);
  assert.match(yaml, /^mixed-port: 7890$/m);
  assert.match(yaml, /enhanced-mode: "fake-ip"/);
  assert.match(yaml, /^ {2}- name: "新加坡 VLESS"$/m);
  assert.match(yaml, /^ {4}reality-opts:\n {6}public-key: "PUBKEY_abc-123"/m);
  assert.match(yaml, /"MATCH,节点选择"/);
  assert.match(yaml, /"GEOIP,CN,DIRECT"/);
  assert.doesNotMatch(yaml, /link:/);
  assert.doesNotMatch(toClash(nodes, 'clash-global'), /GEOIP/);
  assert.match(toClash(nodes, 'proxies'), /^proxies:\n {2}- name:/);
  assert.equal(b64decode(toBase64Sub(nodes)).split('\n').length, 5);
});
