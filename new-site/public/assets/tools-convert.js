// 常用工具: Base64 and subscription / node-link conversion. Pure functions (no DOM), so the
// tests can run them in Node (test/tools.test.mjs). Everything runs in the visitor's browser.

// ---------- Base64 (UTF-8, tolerant of URL-safe alphabet, missing padding and line breaks) ----------

export function b64decodeBytes(input) {
  let s = String(input).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!s) return new Uint8Array();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('不是有效的 Base64');
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) throw new Error('Base64 长度不对，可能复制不完整');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64decode(input) {
  return new TextDecoder().decode(b64decodeBytes(input));
}

export function b64encode(text, urlSafe = false) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const s = btoa(bin);
  return urlSafe ? s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : s;
}

// Decoded bytes that are mostly printable text (so a decode result is worth showing as text)
export function looksLikeText(str) {
  if (!str) return true;
  const bad = (str.match(/[\u0000-\u0008\u000e-\u001f�]/g) || []).length;
  return bad / str.length < 0.02;
}

// ---------- node links ----------

export const SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2'];
const LINK_RE = /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i;

const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Input → list of link lines. Accepts a base64 subscription body, or links one per line.
export function splitInput(text) {
  let body = String(text || '').trim();
  if (!body) return [];
  if (/^\s*(proxies|mixed-port|port|dns)\s*:/m.test(body)) {
    throw new Error('这是 Clash 配置（YAML）。目前只支持把节点链接/订阅转成 Clash，不支持反过来。');
  }
  if (/^https?:\/\//i.test(body) && !body.includes('\n')) {
    throw new Error('这是订阅链接本身。请用浏览器打开它，把页面上的内容复制过来。');
  }
  if (!LINK_RE.test(body)) {
    try {
      const decoded = b64decode(body);
      if (decoded.includes('://')) body = decoded.trim();
    } catch {}
  }
  return body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function hostPort(u) {
  const server = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port);
  if (!server) throw new Error('缺少服务器地址');
  if (!port) throw new Error('缺少端口');
  return { server, port };
}

const bool1 = (v) => v === '1' || v === 'true';
const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

// Transport options shared by VLESS / Trojan / VMess (Clash field names)
function transport(p, net, host, path, serviceName, mode) {
  const out = {};
  if (net === 'ws' || net === 'httpupgrade') {
    out.network = 'ws';
    const ws = {};
    if (path) ws.path = path;
    if (host) ws.headers = { Host: host };
    if (net === 'httpupgrade') ws['v2ray-http-upgrade'] = true;
    out['ws-opts'] = ws;
  } else if (net === 'grpc') {
    out.network = 'grpc';
    out['grpc-opts'] = { 'grpc-service-name': serviceName || '' };
  } else if (net === 'h2' || net === 'http') {
    out.network = 'h2';
    const h2 = {};
    if (host) h2.host = [host];
    if (path) h2.path = path;
    out['h2-opts'] = h2;
  } else if (net === 'xhttp' || net === 'splithttp') {
    out.network = 'xhttp';
    const x = {};
    if (path) x.path = path;
    if (host) x.host = host;
    if (mode) x.mode = mode;
    out['xhttp-opts'] = x;
  } else if (net && net !== 'tcp' && net !== 'raw') {
    throw new Error(`不支持的传输方式 ${net}`);
  }
  return out;
}

function parseVless(link, u) {
  const p = u.searchParams;
  const node = { type: 'vless', ...hostPort(u), uuid: dec(u.username), udp: true };
  if (!node.uuid) throw new Error('缺少 UUID');
  const security = p.get('security') || 'none';
  if (security === 'tls' || security === 'reality') node.tls = true;
  const sni = p.get('sni') || p.get('peer');
  if (sni) node.servername = sni;
  if (p.get('flow')) node.flow = p.get('flow');
  if (p.get('fp')) node['client-fingerprint'] = p.get('fp');
  if (bool1(p.get('allowInsecure')) || bool1(p.get('insecure'))) node['skip-cert-verify'] = true;
  if (p.get('alpn')) node.alpn = list(p.get('alpn'));
  const enc = p.get('encryption');
  if (enc && enc !== 'none') node.encryption = enc;
  if (security === 'reality') {
    if (!p.get('pbk')) throw new Error('REALITY 缺少公钥 pbk');
    node['reality-opts'] = { 'public-key': p.get('pbk') };
    if (p.get('sid')) node['reality-opts']['short-id'] = p.get('sid');
    if (!node['client-fingerprint']) node['client-fingerprint'] = 'chrome';
  }
  const net = p.get('type') || 'tcp';
  Object.assign(node, transport(p, net, p.get('host'), p.get('path'), p.get('serviceName'), p.get('mode')));
  return node;
}

function parseTrojan(link, u) {
  const p = u.searchParams;
  const node = { type: 'trojan', ...hostPort(u), password: dec(u.username), udp: true };
  if (!node.password) throw new Error('缺少密码');
  const sni = p.get('sni') || p.get('peer');
  if (sni) node.sni = sni;
  if (p.get('fp')) node['client-fingerprint'] = p.get('fp');
  if (bool1(p.get('allowInsecure')) || bool1(p.get('insecure'))) node['skip-cert-verify'] = true;
  if (p.get('alpn')) node.alpn = list(p.get('alpn'));
  if (p.get('security') === 'reality') {
    node['reality-opts'] = { 'public-key': p.get('pbk') || '' };
    if (p.get('sid')) node['reality-opts']['short-id'] = p.get('sid');
  }
  Object.assign(node, transport(p, p.get('type') || 'tcp', p.get('host'), p.get('path'), p.get('serviceName'), p.get('mode')));
  return node;
}

function parseHysteria2(link, u) {
  const p = u.searchParams;
  // Port hopping ("443,20000-30000") cannot go through URL parsing; read it from the raw link
  const m = link.match(/^[a-z0-9]+:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::([0-9,\-]+))?/i);
  const server = (m?.[1] || '').replace(/^\[|\]$/g, '');
  if (!server) throw new Error('缺少服务器地址');
  const ports = m?.[2] || '443';
  const at = link.indexOf('@');
  const auth = at > 0 ? dec(link.slice(link.indexOf('://') + 3, at)) : p.get('auth') || '';
  if (!auth) throw new Error('缺少密码');
  const node = { type: 'hysteria2', server, port: Number(ports.split(/[,-]/)[0]) || 443, password: auth, udp: true };
  if (/[,-]/.test(ports)) node.ports = ports;
  const sni = p.get('sni') || p.get('peer');
  if (sni) node.sni = sni;
  if (bool1(p.get('insecure')) || bool1(p.get('allowInsecure'))) node['skip-cert-verify'] = true;
  const pin = p.get('pinSHA256');
  if (pin) node.fingerprint = pin.replace(/:/g, '').toLowerCase();
  if (p.get('obfs') && p.get('obfs') !== 'none') {
    node.obfs = p.get('obfs');
    node['obfs-password'] = p.get('obfs-password') || '';
  }
  if (p.get('alpn')) node.alpn = list(p.get('alpn'));
  return node;
}

function parseSs(link) {
  let rest = link.slice(5);
  let name = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    name = dec(rest.slice(hash + 1));
    rest = rest.slice(0, hash);
  }
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  rest = rest.replace(/\/$/, '');
  let userinfo;
  let hp;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    // SIP002: base64url(method:password)@host:port, or percent-encoded method:password (SS-2022)
    const raw = rest.slice(0, at);
    hp = rest.slice(at + 1);
    userinfo = raw.includes(':') || raw.includes('%3A') || raw.includes('%3a') ? dec(raw) : b64decode(dec(raw));
  } else {
    // Legacy: base64(method:password@host:port)
    const all = b64decode(dec(rest));
    const i = all.lastIndexOf('@');
    if (i < 0) throw new Error('无法解析 ss 链接');
    userinfo = all.slice(0, i);
    hp = all.slice(i + 1);
  }
  const c = userinfo.indexOf(':');
  if (c < 0) throw new Error('ss 链接缺少加密方式或密码');
  const hm = hp.match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!hm) throw new Error('ss 链接缺少地址或端口');
  const node = { type: 'ss', name, server: hm[1], port: Number(hm[2]), cipher: userinfo.slice(0, c), password: userinfo.slice(c + 1), udp: true };
  const plugin = new URLSearchParams(query).get('plugin');
  if (plugin) {
    const [pname, ...opts] = plugin.split(';');
    const kv = Object.fromEntries(opts.map((o) => { const i = o.indexOf('='); return i < 0 ? [o, true] : [o.slice(0, i), o.slice(i + 1)]; }));
    if (pname === 'obfs-local' || pname === 'simple-obfs') {
      node.plugin = 'obfs';
      node['plugin-opts'] = { mode: kv.obfs || 'http', ...(kv['obfs-host'] ? { host: kv['obfs-host'] } : {}) };
    } else if (pname === 'v2ray-plugin') {
      node.plugin = 'v2ray-plugin';
      node['plugin-opts'] = { mode: kv.mode || 'websocket', ...(kv.tls ? { tls: true } : {}), ...(kv.host ? { host: kv.host } : {}), ...(kv.path ? { path: kv.path } : {}) };
    } else {
      throw new Error(`不支持的 ss 插件 ${pname}`);
    }
  }
  return node;
}

function parseVmess(link) {
  let j;
  try {
    j = JSON.parse(b64decode(link.slice(8).split('#')[0]));
  } catch {
    throw new Error('vmess 链接内容不是有效的 JSON');
  }
  const port = Number(j.port);
  if (!j.add || !port || !j.id) throw new Error('vmess 链接缺少地址、端口或 UUID');
  const node = { type: 'vmess', name: String(j.ps || ''), server: String(j.add), port, uuid: String(j.id), alterId: Number(j.aid) || 0, cipher: j.scy || 'auto', udp: true };
  if (j.tls === 'tls') {
    node.tls = true;
    if (j.sni) node.servername = String(j.sni);
    if (j.fp) node['client-fingerprint'] = String(j.fp);
    if (j.alpn) node.alpn = list(String(j.alpn));
  }
  Object.assign(node, transport(null, j.net || 'tcp', j.host, j.path, j.path, ''));
  return node;
}

// One link → Clash proxy object (plus .link, the original text)
export function parseLink(line) {
  const link = String(line).trim();
  const m = link.match(LINK_RE);
  if (!m) throw new Error('不认识的链接类型');
  const scheme = m[1].toLowerCase();
  let node;
  if (scheme === 'ss') node = parseSs(link);
  else if (scheme === 'vmess') node = parseVmess(link);
  else {
    let u;
    try {
      u = new URL(link);
    } catch {
      if (scheme !== 'hysteria2' && scheme !== 'hy2') throw new Error('链接格式不对');
    }
    if (scheme === 'vless') node = parseVless(link, u);
    else if (scheme === 'trojan') node = parseTrojan(link, u);
    else node = parseHysteria2(link, u || new URL('http://x/?' + (link.split('?')[1] || '').split('#')[0]));
    const h = link.indexOf('#');
    node.name = h >= 0 ? dec(link.slice(h + 1)) : '';
  }
  if (!node.name) node.name = `${node.type} ${node.server}:${node.port}`;
  // Keep `name` first in the output
  const { name, ...rest } = node;
  return { name, ...rest, link };
}

// Parse every line; bad lines are reported, not fatal
export function parseAll(lines) {
  const nodes = [];
  const errors = [];
  const seen = new Map();
  lines.forEach((line, i) => {
    try {
      const n = parseLink(line);
      const base = n.name;
      let k = seen.get(base) || 0;
      while (seen.has(n.name)) n.name = `${base} ${++k + 1}`;
      seen.set(base, k);
      seen.set(n.name, 0);
      nodes.push(n);
    } catch (err) {
      errors.push({ line: i + 1, text: line.slice(0, 60), error: err.message });
    }
  });
  return { nodes, errors };
}

// ---------- YAML output ----------

const q = (s) => JSON.stringify(String(s)); // JSON strings are valid YAML double-quoted scalars

function scalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return q(v);
}

function emit(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.every((x) => typeof x !== 'object')) return ` [${value.map(scalar).join(', ')}]`;
    return '\n' + value.map((x) => `${pad}- ${emit(x, indent + 2).replace(/^\n\s*/, '')}`).join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) return ' {}';
    return '\n' + keys.map((k) => `${pad}${/^[\w.-]+$/.test(k) ? k : q(k)}:${emit(value[k], indent + 2)}`).join('\n');
  }
  return ' ' + scalar(value);
}

export function toYaml(obj) {
  return emit(obj, 0).replace(/^\n/, '') + '\n';
}

const DOH_CN = ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query'];
export const CLASH_DNS = {
  enable: true,
  ipv6: false,
  'enhanced-mode': 'fake-ip',
  'fake-ip-range': '198.18.0.1/16',
  'fake-ip-filter': ['*.lan', '+.local'],
  'respect-rules': true,
  'default-nameserver': ['223.5.5.5', '119.29.29.29'],
  nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
  'proxy-server-nameserver': DOH_CN,
  'direct-nameserver': DOH_CN,
  'nameserver-policy': { '+.cn': DOH_CN },
};

const LAN_RULES = [
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
];

const proxyOf = ({ link, ...rest }) => rest;

// mode: 'clash' (China direct), 'clash-global' (everything through the proxy), 'proxies'
export function toClash(nodes, mode = 'clash') {
  const proxies = nodes.map(proxyOf);
  if (mode === 'proxies') return toYaml({ proxies });
  const names = proxies.map((p) => p.name);
  const SELECT = '节点选择';
  const AUTO = '自动选择';
  const config = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    dns: CLASH_DNS,
    proxies,
    'proxy-groups': [
      { name: SELECT, type: 'select', proxies: [AUTO, ...names, 'DIRECT'] },
      { name: AUTO, type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 300, tolerance: 50, proxies: names },
    ],
    rules: mode === 'clash-global'
      ? [...LAN_RULES, `MATCH,${SELECT}`]
      : [...LAN_RULES, 'DOMAIN-SUFFIX,cn,DIRECT', 'GEOIP,CN,DIRECT', `MATCH,${SELECT}`],
  };
  return toYaml(config);
}

export function toLinks(nodes) {
  return nodes.map((n) => n.link).join('\n') + '\n';
}

export function toBase64Sub(nodes) {
  return b64encode(nodes.map((n) => n.link).join('\n'));
}
